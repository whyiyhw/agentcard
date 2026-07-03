/**
 * agentcard — ask agent engine (Cloudflare Worker) · 站点信息全在 config.js
 *
 * - GET  /              → 前端静态页（assets binding）
 * - POST /api           → AI proxy（DeepSeek）+ 会话落库 + 线索检测
 * - GET  /admin?t=TOKEN → 后台：会话列表 / 对话回放 / 线索（ADMIN_TOKEN 保护）
 * - cron 01:00 UTC      → Lark 日报（北京 09:00）
 *
 * secrets：
 *   wrangler secret put DEEPSEEK_API_KEY   # 必填
 *   wrangler secret put ADMIN_TOKEN        # 必填（/admin 的钥匙，随便一串长随机字符）
 *   wrangler secret put LARK_WEBHOOK       # 可选（Lark 自定义机器人 webhook，不填则不通知）
 *
 * 隐私红线：IP 只存截断哈希；微信号不进 prompt（走服务端工具门控发放）。
 *
 * 请求:  POST /api {q, lang, sid?, history?}
 * 响应:  200 {answer} | 4xx/5xx {error} —— 前端收到非 answer 自动回退本地脚本
 */

import { SITE, SYSTEM_PROMPT, CURL_CARD, RESUME_MAIL, AGENT_CARD } from "./config.js";
const SITE_HOST = new URL(SITE.origin).host; // 通知标题里的站点标识，从 config 派生 —— 引擎内不留个人字面量

// —— 输入上限（防滥用，key 是自己的钱包）——
const MAX_Q = 500;          // 单条问题字符数
const MAX_HISTORY = 8;      // 携带的多轮消息数
const MAX_MSG = 1000;       // 历史单条字符数
const MAX_TOKENS = 500;     // DeepSeek 回答上限

// —— 每 IP 限速（isolate 内存级，best-effort）——
const RATE_LIMIT = 10;      // 次
const RATE_WINDOW = 60_000; // 每分钟
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  if (arr.length >= RATE_LIMIT) return true;
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // 内存保险丝
  return false;
}

// —— 线索检测：关键词 + 联系方式正则，与下方 function-calling 工具并存（双保险）——
// 微信段：关键词前不能是字母数字（防 "testwx2026" 里的 wx 误命中）；后面容忍 号/码/是/为/冒号/等号
const CONTACT_RE = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(?:^|\D)(1[3-9]\d{9})(?:\D|$)|(?:^|[^a-z0-9])(?:微信|weixin|wechat|vx|wx)[号码]?\s*[是为:：=]?\s*([a-zA-Z][\w-]{4,19})/i;
const INTENT_RE = /(合作|接活|外包|报价|预算|付费|酬劳|兼职|想找(你|他)|找人做|hire|freelanc|paid|budget|quote|collab|project for)/i;

function corsHeaders(origin, env) {
  const list = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = list.includes("*") || list.includes(origin);
  return {
    headers: {
      "access-control-allow-origin": ok ? (origin || "*") : "null",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
      vary: "origin",
    },
    ok,
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

async function ipHash(ip) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SITE_HOST + ".ask|" + ip));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ==================== 通知（机制对齐 seek internal/routines/webhook.go + feishu_bot.go）====================
// 格式（LARK_FORMAT）：
//   feishu       飞书「企业自建应用」bot，走 IM 开放 API（不再用群机器人 webhook，seek 已同步弃用）
//                env：FEISHU_APP_ID(var) · FEISHU_APP_SECRET(secret) · FEISHU_RECEIVE_ID(var)
//                     FEISHU_RECEIVE_ID_TYPE(var，默认 chat_id；群=chat_id，私聊=open_id)
//   slack        {text} · discord {content} · ntfy 纯文本 + Title/Tags 头（走 LARK_WEBHOOK URL）
//   template     LARK_TEMPLATE 里写完整 JSON，{{title}}/{{body}}/{{event}} 占位（JSON 转义替换）
//   raw          {event, title, body}

// —— 飞书自建应用 bot（1:1 移植 seek feishu_bot.go；三个坑都在注释里）——
const FEISHU_BASE = "https://open.feishu.cn/open-apis";
// token 失效类错误码：值得刷新重试一次（99991663 invalid / 99991664 expired / 99991668 type
// mismatch / 99991671 refresh / 99991672 permission，授权刚生效时偶发）
const FEISHU_TOKEN_ERRORS = new Set([99991663, 99991664, 99991668, 99991671, 99991672]);
// isolate 内存级 token 缓存：7200s TTL、提前 5 分钟刷新、inflight 单飞防并发重复取
const feishuTok = { token: "", expiresAt: 0, inflight: null };

async function feishuToken(env) {
  if (feishuTok.token && Date.now() < feishuTok.expiresAt - 300_000) return feishuTok.token;
  if (feishuTok.inflight) return feishuTok.inflight;
  feishuTok.inflight = (async () => {
    try {
      const r = await fetch(FEISHU_BASE + "/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
        signal: AbortSignal.timeout(5_000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.code !== 0 || !j.tenant_access_token) {
        throw new Error(`feishu token: HTTP ${r.status} code=${j?.code} msg=${j?.msg || ""}`);
      }
      feishuTok.token = j.tenant_access_token;
      feishuTok.expiresAt = Date.now() + (j.expire || 7200) * 1000;
      return feishuTok.token;
    } finally {
      feishuTok.inflight = null;
    }
  })();
  return feishuTok.inflight;
}

async function sendFeishuBot(env, title, body) {
  const rt = env.FEISHU_RECEIVE_ID_TYPE || "chat_id";
  let text = title + "\n" + body;
  if (text.length > 100_000) text = text.slice(0, 100_000) + "\n…(truncated)"; // 飞书上限 150KB，防御性截断
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await feishuToken(env);
    const r = await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=${encodeURIComponent(rt)}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: env.FEISHU_RECEIVE_ID,
        msg_type: "text",
        content: JSON.stringify({ text }), // 坑：content 必须双重编码（值是序列化后的 JSON 字符串）
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (r.status >= 500 && attempt === 0) continue;
    const j = await r.json().catch(() => null);
    if (r.status >= 400) throw new Error(`feishu im/v1/messages HTTP ${r.status} code=${j?.code} msg=${j?.msg || ""}`);
    if (!j || typeof j.code !== "number") throw new Error("feishu: unparseable response");
    if (j.code === 0) return; // 坑：HTTP 200 不代表成功，必须看 body code
    if (FEISHU_TOKEN_ERRORS.has(j.code) && attempt === 0) {
      feishuTok.token = ""; feishuTok.expiresAt = 0; // 刷新一次再试
      continue;
    }
    throw new Error(`feishu im/v1/messages code=${j.code} msg=${j.msg || ""}`);
  }
}

// —— 通用 webhook 路径（slack/discord/ntfy/template/raw）——
function jsonEscape(s) {
  return JSON.stringify(String(s)).slice(1, -1); // 去掉外层引号，可安全塞进 JSON 字符串槽位
}

function buildNotifyRequest(env, event, title, body) {
  const url = env.LARK_WEBHOOK;
  const format = (env.LARK_FORMAT || "raw").trim();
  const J = (payload) => ({ url, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } });
  switch (format) {
    case "slack":   return J({ text: title + "\n" + body });
    case "discord": return J({ content: "**" + title + "**\n" + body });
    case "ntfy":    return { url, init: { method: "POST", headers: { Title: title, Tags: event }, body } };
    case "template": {
      let rendered = env.LARK_TEMPLATE || "";
      rendered = rendered.replaceAll("{{title}}", jsonEscape(title)).replaceAll("{{body}}", jsonEscape(body)).replaceAll("{{event}}", jsonEscape(event));
      try { JSON.parse(rendered); } catch { console.error("notify: template did not render to valid JSON"); return null; }
      return { url, init: { method: "POST", headers: { "content-type": "application/json" }, body: rendered } };
    }
    case "raw": default:
      return J({ event, title, body });
  }
}

async function notify(env, event, title, body) {
  const format = (env.LARK_FORMAT || "").trim();
  // 飞书自建应用 bot：不走 LARK_WEBHOOK，走 IM API
  if (format === "feishu") {
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_RECEIVE_ID) {
      console.error("notify: feishu 需要 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_RECEIVE_ID");
      return;
    }
    try { await sendFeishuBot(env, title, body); }
    catch (e) { console.error("notify feishu:", e?.message || e); }
    return;
  }
  if (!env.LARK_WEBHOOK) return;
  const req = buildNotifyRequest(env, event, title, body);
  if (!req) return;
  // 对齐 seek：传输错误 / 5xx 重试一次；4xx 是配置问题，不重试
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(5_000) });
      if (r.status >= 500 && attempt === 0) continue;
      if (r.status >= 400) { console.error(`notify: HTTP ${r.status}`); return; }
      const data = await r.json().catch(() => null);
      if (data && typeof data.code === "number" && data.code !== 0) {
        console.error("notify: body code", data.code, data.msg || "");
      }
      return;
    } catch (e) {
      if (attempt === 0) continue;
      console.error("notify error", e?.message || e);
    }
  }
}

// ==================== 邮件发送（MailerSend / Resend，配哪家用哪家）====================
// MAILERSEND_API_KEY（mlsn. 开头）优先；RESEND_API_KEY（re_ 开头）兜底。
// 发件人 RESEND_FROM（"名字 <addr>" 格式）需挂在对应平台已验证的域名下。

async function sendEmail(env, { to, subject, text }) {
  const from = env.RESEND_FROM || `${SITE.owner.name} <${SITE.owner.email}>`;
  const m = from.match(/^(.*?)\s*<(.+)>$/);
  const fromName = m ? m[1].trim() : SITE.owner.name;
  const fromEmail = m ? m[2] : from;
  const replyTo = env.REPLY_TO || SITE.owner.email;
  try {
    if (env.MAILERSEND_API_KEY) {
      const r = await fetch("https://api.mailersend.com/v1/email", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.MAILERSEND_API_KEY}` },
        body: JSON.stringify({
          from: { email: fromEmail, name: fromName },
          to: [{ email: to }],
          reply_to: { email: replyTo },
          subject,
          text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 202 || r.ok) return true;
      console.error("mailersend error", r.status, (await r.text().catch(() => "")).slice(0, 300));
      return false;
    }
    if (env.RESEND_API_KEY) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
        body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return true;
      console.error("resend error", r.status, (await r.text().catch(() => "")).slice(0, 300));
      return false;
    }
  } catch (e) {
    console.error("email error", e?.message || e);
    return false;
  }
  console.error("email: no provider configured");
  return false;
}

// ==================== Agent 工具（DeepSeek function calling）====================
// 原则：敏感值只在服务端。微信号存 secret WECHAT_ID，模型只有在门控通过后才看到返回值。

const TOOLS = [
  {
    type: "function",
    function: {
      name: "leave_contact",
      description: `访客留下自己的联系方式和需求/来意时调用，把线索记录给主人 ${SITE.owner.name}（会主动联系对方）`,
      parameters: {
        type: "object",
        properties: {
          contact: { type: "string", description: "访客的邮箱 / 微信号 / 手机号，原样保留" },
          pitch: { type: "string", description: "访客的需求或来意，一句话概括" },
        },
        required: ["contact", "pitch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "offer_wechat",
      description: `访客想要主人 ${SITE.owner.name} 的微信号时调用。服务端校验：访客必须已留过自己的联系方式，否则拒绝`,
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_brief",
      description: "访客想快速了解 / 要合作简介时调用，返回一页版合作简介 PDF 的链接（人人可得）",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_resume",
      description: "访客认真想要完整简历、且在对话里给出了自己的邮箱时调用——把完整简历发到对方邮箱。服务端会校验邮箱确实是访客自己发出来的",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "访客自己提供的邮箱，原样传入" },
        },
        required: ["email"],
      },
    },
  },
];

async function execTool(env, name, args, sid, request, extra) {
  const now = Date.now();
  const cf = request.cf || {};
  try {
    switch (name) {
      case "send_resume": {
        const email = String(args.email || "").trim().toLowerCase().slice(0, 120);
        if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(email)) return { ok: false, reason: "invalid_email" };
        if ((!env.MAILERSEND_API_KEY && !env.RESEND_API_KEY) || !env.DB) return { ok: false, reason: "not_configured" };
        // 门控①：邮箱必须是访客自己在对话里敲出来的（当前问题 or 本会话历史）——模型编不出没出现过的地址
        const inNow = String(extra?.q || "").toLowerCase().includes(email);
        if (!inNow) {
          const row = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM messages WHERE session_id=?1 AND role='q' AND content LIKE ?2`
          ).bind(sid, `%${email}%`).first();
          if (!row?.n) return { ok: false, reason: "email_not_provided_by_visitor" };
        }
        // 门控②：同邮箱 7 天内不重发；③ 每会话最多 1 次；④ 全局每日 ≤10（烧不穿的保险丝）
        const dup = await env.DB.prepare(`SELECT COUNT(*) AS n FROM resume_sends WHERE email=?1 AND ts>?2`)
          .bind(email, now - 7 * 86400e3).first();
        if (dup?.n) return { ok: false, reason: "already_sent_recently" };
        const per = await env.DB.prepare(`SELECT COUNT(*) AS n FROM resume_sends WHERE session_id=?1`).bind(sid).first();
        if (per?.n) return { ok: false, reason: "already_sent_this_session" };
        const day = await env.DB.prepare(`SELECT COUNT(*) AS n FROM resume_sends WHERE ts>?1`).bind(now - 86400e3).first();
        if ((day?.n || 0) >= 10) return { ok: false, reason: "daily_quota_reached" };
        // 专属链接（随机 token，7 天有效，打开会通知主人）
        const tok = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
        // 固定模板：访客的任何输入都不进邮件正文，没有内容注入面
        const sent = await sendEmail(env, {
          to: email,
          subject: RESUME_MAIL.subject,
          text: RESUME_MAIL.text(tok),
        });
        if (!sent) return { ok: false, reason: "send_failed" };
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO resume_sends (session_id, ts, email, token) VALUES (?1, ?2, ?3, ?4)`).bind(sid, now, email, tok),
          env.DB.prepare(`INSERT INTO leads (session_id, ts, contact, pitch, source) VALUES (?1, ?2, ?3, '简历已发送', 'resume-sent')`).bind(sid, now, email),
        ]);
        await notify(env, "lead.new", `📄 简历已发送 · ${SITE_HOST}`,
          `${cf.country || ""} ${cf.city || ""}\n收件: ${email}\n回放: ${SITE.origin}/admin/session?id=${sid}`);
        return { ok: true, note: `resume emailed, link valid 7 days, reply reaches ${SITE.owner.name} directly` };
      }
      case "leave_contact": {
        const contact = String(args.contact || "").trim().slice(0, 120);
        const pitch = String(args.pitch || "").trim().slice(0, 300);
        if (!contact) return { ok: false, reason: "empty_contact" };
        if (env.DB) {
          await env.DB.prepare(`INSERT INTO leads (session_id, ts, contact, pitch, source) VALUES (?1, ?2, ?3, ?4, 'tool')`)
            .bind(sid, now, contact, pitch).run();
        }
        await notify(env, "lead.new", `🧲 新线索（主动留联）· ${SITE_HOST}`,
          `${cf.country || ""} ${cf.city || ""}\n联系: ${contact}\n来意: ${pitch}\n回放: ${SITE.origin}/admin/session?id=${sid}`);
        return { ok: true, note: `recorded, ${SITE.owner.name} will reach out` };
      }
      case "offer_wechat": {
        if (!env.WECHAT_ID) return { ok: false, reason: "not_configured" };
        if (!env.DB) return { ok: false, reason: "visitor_must_leave_contact_first" };
        // 门控：该会话必须已留过联系方式（tool 或 auto 均可）
        const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE session_id=?1 AND contact!=''`).bind(sid).first();
        if (!row?.n) return { ok: false, reason: "visitor_must_leave_contact_first" };
        // 防复读：一个会话最多放行 2 次
        const given = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE session_id=?1 AND source='wechat-offer'`).bind(sid).first();
        if ((given?.n || 0) >= 2) return { ok: false, reason: "already_offered" };
        await env.DB.prepare(`INSERT INTO leads (session_id, ts, contact, pitch, source) VALUES (?1, ?2, '', '微信号已发放', 'wechat-offer')`)
          .bind(sid, now).run();
        await notify(env, "lead.new", `🤝 微信号已发放 · ${SITE_HOST}`,
          `${cf.country || ""} ${cf.city || ""}\n回放: ${SITE.origin}/admin/session?id=${sid}`);
        return { ok: true, wechat: env.WECHAT_ID, note: "gate passed" };
      }
      case "send_brief":
        return { ok: true, url: `${SITE.origin}/brief.pdf` };
      default:
        return { ok: false, reason: "unknown_tool" };
    }
  } catch (e) {
    console.error("tool error", name, e?.message || e);
    return { ok: false, reason: "internal_error" };
  }
}

// ==================== 落库 + 线索 ====================

/** 一次问答后的旁路处理：落库 + 线索检测 + 实时通知（waitUntil 内跑，不阻塞响应） */
async function afterExchange(env, ctx0) {
  const { sid, q, answer, lang, latency, tokens, request } = ctx0;
  if (!env.DB) return; // 未绑 D1 时静默跳过，站点照常工作
  const now = Date.now();
  const cf = request.cf || {};
  const country = cf.country || "";
  const city = cf.city || "";
  try {
    const iph = await ipHash(request.headers.get("cf-connecting-ip") || "?");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (id, first_ts, last_ts, country, city, ua, lang, ip_hash, turns)
         VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, 1)
         ON CONFLICT(id) DO UPDATE SET last_ts=?2, turns=turns+1, lang=?6`
      ).bind(sid, now, country, city, (request.headers.get("user-agent") || "").slice(0, 200), lang, iph),
      env.DB.prepare(
        `INSERT INTO messages (session_id, ts, role, content) VALUES (?1, ?2, 'q', ?3)`
      ).bind(sid, now, q),
      env.DB.prepare(
        `INSERT INTO messages (session_id, ts, role, content, latency_ms, tokens) VALUES (?1, ?2, 'a', ?3, ?4, ?5)`
      ).bind(sid, now + 1, answer, latency, tokens),
    ]);

    // 线索检测（只看访客的问题）
    const cm = q.match(CONTACT_RE);
    const im = INTENT_RE.test(q);
    if (cm || im) {
      const contact = cm ? (cm[1] || cm[2] || cm[3] || "") : "";
      await env.DB.prepare(
        `INSERT INTO leads (session_id, ts, contact, pitch, source) VALUES (?1, ?2, ?3, ?4, 'auto')`
      ).bind(sid, now, contact, q).run();
      // 同一会话最多实时推 3 条，防刷屏
      const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE session_id=?1`).bind(sid).first();
      if ((c?.n || 0) <= 3) {
        await notify(
          env,
          "lead.new",
          `🧲 新线索 · ${SITE_HOST}`,
          `${country} ${city} · lang=${lang}\n` +
            `Q: ${q.slice(0, 180)}\n` +
            (contact ? `联系: ${contact}\n` : "") +
            `回放: ${SITE.origin}/admin/session?id=${sid}`
        );
      }
    }
  } catch (e) {
    console.error("d1 log error", e?.message || e);
  }
}

// ==================== DeepSeek SSE 流解析 ====================
// 逐 chunk 读上游 SSE：文本增量回调 onDelta；tool_calls 按 index 聚合分片参数
async function pumpDeepSeekStream(body, onDelta) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", tokens = 0;
  const tcs = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      if (j.usage?.total_tokens) tokens = j.usage.total_tokens;
      const delta = j.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; onDelta(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        tcs[i] = tcs[i] || { id: "", name: "", args: "" };
        if (tc.id) tcs[i].id = tc.id;
        if (tc.function?.name) tcs[i].name = tc.function.name;
        if (tc.function?.arguments) tcs[i].args += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls: tcs.filter(Boolean), tokens };
}

// ==================== /admin 后台（Worker 直出 HTML）====================

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtTs(ts) {
  // 北京时间
  return new Date(ts + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
}
function page(title, body) {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>
:root{color-scheme:dark}body{background:#08090c;color:#e7e9ee;font:14px/1.7 "JetBrains Mono",Menlo,monospace;margin:0;padding:28px 18px}
.wrap{max-width:960px;margin:0 auto}a{color:#3fe0ea;text-decoration:none;border-bottom:1px dotted #3fe0ea}
h1{font-size:18px;color:#ffb020}h1 a{color:#ffb020;border:0}.dim{color:#5b6473}.muted{color:#8b93a1}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}
.stat{background:#0f1218;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 18px;min-width:120px}
.stat b{display:block;font-size:22px;color:#3fe0ea}.stat span{font-size:12px;color:#8b93a1}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
th{color:#5b6473;text-align:left;font-weight:400;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.16)}
td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.07);vertical-align:top}
tr:hover td{background:rgba(255,255,255,.03)}
.q{color:#e7e9ee}.tag{color:#ffb020;font-size:12px}
.msg{margin:10px 0;padding:10px 14px;border-radius:10px;max-width:72ch;white-space:pre-wrap;word-break:break-word}
.msg.q{background:#141821;border:1px solid rgba(255,255,255,.12)}
.msg.a{background:rgba(63,224,234,.06);border:1px solid rgba(63,224,234,.25)}
.msg .m{font-size:11px;color:#5b6473;margin-bottom:4px}
h2{font-size:14px;color:#ffb020;margin:26px 0 4px}
</style></head><body><div class="wrap">${body}</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function handleAdmin(env, url) {
  const t = url.searchParams.get("t") || "";
  if (!env.ADMIN_TOKEN || t !== env.ADMIN_TOKEN) return new Response("not found", { status: 404 });

  // 通知链路探针：GET /admin/probe?t=TOKEN → 发一条测试通知（失败原因看 wrangler tail）
  if (url.pathname === "/admin/probe") {
    await notify(env, "test", `✅ ${SITE_HOST} 通知测试`, "看到这条说明通知链路已通。");
    return json({ ok: true, note: "probe sent — check Feishu; errors go to wrangler tail" }, 200, {});
  }

  if (!env.DB) return page("admin", "<h1>admin</h1><p class='dim'>D1 未绑定：先 wrangler d1 create 并在 wrangler.toml 填 database_id。</p>");
  const T = encodeURIComponent(t);

  // —— 会话回放 ——
  if (url.pathname === "/admin/session") {
    const id = url.searchParams.get("id") || "";
    const s = await env.DB.prepare(`SELECT * FROM sessions WHERE id=?1`).bind(id).first();
    const ms = await env.DB.prepare(`SELECT * FROM messages WHERE session_id=?1 ORDER BY ts LIMIT 500`).bind(id).all();
    const head = s
      ? `<p class="dim">${esc(s.country)} ${esc(s.city)} · lang=${esc(s.lang)} · turns=${s.turns} · ${fmtTs(s.first_ts)} → ${fmtTs(s.last_ts)}<br>${esc(s.ua)}</p>`
      : `<p class="dim">unknown session</p>`;
    const body = (ms.results || [])
      .map((m) => `<div class="msg ${m.role}"><div class="m">${m.role === "q" ? "visitor" : "agent"} · ${fmtTs(m.ts)}${m.latency_ms ? " · " + m.latency_ms + "ms" : ""}${m.tokens ? " · " + m.tokens + " tok" : ""}</div>${esc(m.content)}</div>`)
      .join("");
    return page("session " + id, `<h1><a href="/admin?t=${T}">← admin</a> / session</h1>${head}${body || "<p class='dim'>empty</p>"}`);
  }

  // —— 仪表盘 ——
  const now = Date.now();
  const dayStart = now - ((now + 8 * 3600e3) % 86400e3); // 北京时区今日 0 点
  const weekAgo = now - 7 * 86400e3;
  const [sToday, qToday, leads7, recent, leads] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE last_ts>=?1`).bind(dayStart).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE role='q' AND ts>=?1`).bind(dayStart).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ts>=?1`).bind(weekAgo).first(),
    env.DB.prepare(
      `SELECT s.*, (SELECT content FROM messages m WHERE m.session_id=s.id AND m.role='q' ORDER BY m.ts LIMIT 1) AS first_q
       FROM sessions s ORDER BY s.last_ts DESC LIMIT 50`
    ).all(),
    env.DB.prepare(`SELECT * FROM leads ORDER BY ts DESC LIMIT 20`).all(),
  ]);

  const rows = (recent.results || [])
    .map(
      (s) => `<tr><td class="dim">${fmtTs(s.last_ts)}</td><td>${esc(s.country)} ${esc(s.city)}</td><td>${s.turns}</td>
<td class="q">${esc((s.first_q || "").slice(0, 60))}</td><td><a href="/admin/session?id=${encodeURIComponent(s.id)}&t=${T}">回放</a></td></tr>`
    )
    .join("");
  const leadRows = (leads.results || [])
    .map(
      (l) => `<tr><td class="dim">${fmtTs(l.ts)}</td><td class="tag">${esc(l.contact || "—")}</td>
<td class="q">${esc((l.pitch || "").slice(0, 70))}</td><td><a href="/admin/session?id=${encodeURIComponent(l.session_id)}&t=${T}">回放</a></td></tr>`
    )
    .join("");

  return page(
    `${SITE.name} admin`,
    `<h1>${SITE.name} <span class="dim">admin</span></h1>
<div class="stats">
  <div class="stat"><b>${sToday?.n || 0}</b><span>今日会话</span></div>
  <div class="stat"><b>${qToday?.n || 0}</b><span>今日提问</span></div>
  <div class="stat"><b>${leads7?.n || 0}</b><span>7 天线索</span></div>
</div>
<h2>// leads</h2>
<table><tr><th>时间</th><th>联系</th><th>原话</th><th></th></tr>${leadRows || ""}</table>
<h2>// sessions</h2>
<table><tr><th>最近活跃</th><th>地区</th><th>turns</th><th>首问</th><th></th></tr>${rows || ""}</table>`
  );
}

// ==================== Agent 管线（/api 非流式 与 /a2a 共用）====================

async function callDeepSeek(env, msgs, withTools) {
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: msgs,
      max_tokens: MAX_TOKENS,
      temperature: 0.45, // 人设一致性优先于发散
      ...(withTools ? { tools: TOOLS } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("deepseek error", r.status, detail.slice(0, 200));
    const err = new Error(`upstream ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** 完整一问一答（含工具循环：最多 2 轮 tool_calls，第 3 次强制纯文本收尾） */
async function runAgent(env, request, { q, lang, sid, history }) {
  let msgs = [
    { role: "system", content: SYSTEM_PROMPT + `\n\n（本次访客界面语言 lang=${lang}）` },
    ...(history || []),
    { role: "user", content: q },
  ];
  let answer = "";
  const toolsUsed = [];
  let tokens = 0;
  for (let round = 0; round < 3; round++) {
    const data = await callDeepSeek(env, msgs, round < 2);
    tokens += data?.usage?.total_tokens || 0;
    const m = data?.choices?.[0]?.message;
    if (!m) break;
    const calls = (m.tool_calls || []).slice(0, 3);
    if (calls.length && round < 2) {
      msgs = [...msgs, m];
      for (const tc of calls) {
        const name = tc.function?.name || "?";
        let targs = {};
        try { targs = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        toolsUsed.push(name);
        const result = await execTool(env, name, targs, sid, request, { q });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    answer = (m.content || "").trim();
    break;
  }
  return { answer, toolsUsed, tokens };
}

// ==================== 主入口 ====================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 后台（GET，token 保护；assets 里没有 /admin 文件，会落到 worker）
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(env, url);
    }

    // ==================== A2A：让别人的 agent 发现并询问这张名片 ====================
    // 薄适配：只支持 message/send（无 Task 生命周期）；contextId 复用 D1 历史实现多轮
    if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
      return json(AGENT_CARD, 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" });
    }
    if (url.pathname === "/a2a") {
      const ah = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: ah });
      if (request.method !== "POST") return json({ error: "POST only" }, 405, ah);
      const aip = request.headers.get("cf-connecting-ip") || "?";
      if (rateLimited(aip)) return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "rate limited, retry in a minute" } }, 429, ah);
      if (!env.DEEPSEEK_API_KEY) return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "agent not configured" } }, 500, ah);
      let rpc;
      try { rpc = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400, ah); }
      const rid = rpc?.id ?? null;
      if (rpc?.method !== "message/send") {
        return json({ jsonrpc: "2.0", id: rid, error: { code: -32601, message: "method not found (only message/send is supported)" } }, 200, ah);
      }
      const parts = rpc?.params?.message?.parts || [];
      const text = parts
        .filter((p) => p && (p.kind === "text" || p.type === "text") && typeof p.text === "string")
        .map((p) => p.text).join("\n").trim().slice(0, MAX_Q);
      if (!text) return json({ jsonrpc: "2.0", id: rid, error: { code: -32602, message: "message must contain a text part" } }, 200, ah);
      const rawCtx = String(rpc?.params?.message?.contextId || "");
      const contextId = /^[A-Za-z0-9._-]{6,56}$/.test(rawCtx) ? rawCtx : crypto.randomUUID();
      const sidA = "a2a-" + contextId;
      const langA = /[一-鿿]/.test(text) ? "zh" : "en";
      // contextId 多轮：从 D1 取该上下文最近的历史
      let historyA = [];
      if (env.DB) {
        try {
          const ms = await env.DB.prepare(`SELECT role, content FROM messages WHERE session_id=?1 ORDER BY ts DESC LIMIT ${MAX_HISTORY}`).bind(sidA).all();
          historyA = (ms.results || []).reverse().map((m) => ({ role: m.role === "q" ? "user" : "assistant", content: m.content.slice(0, MAX_MSG) }));
        } catch {}
      }
      const tA = Date.now();
      try {
        const { answer, toolsUsed, tokens } = await runAgent(env, request, { q: text, lang: langA, sid: sidA, history: historyA });
        if (!answer) throw new Error("empty completion");
        const logged = (toolsUsed.length ? `[tools: ${toolsUsed.join(",")}] ` : "") + answer;
        ctx.waitUntil(afterExchange(env, { sid: sidA, q: text, answer: logged, lang: langA, latency: Date.now() - tA, tokens, request }));
        return json({
          jsonrpc: "2.0",
          id: rid,
          result: {
            kind: "message",
            role: "agent",
            messageId: crypto.randomUUID(),
            contextId,
            parts: [{ kind: "text", text: answer }],
            metadata: { tools: toolsUsed },
          },
        }, 200, ah);
      } catch (e) {
        console.error("a2a error", e?.message || e);
        ctx.waitUntil(afterExchange(env, { sid: sidA, q: text, answer: `⚠ ${e?.message || "error"}`, lang: langA, latency: Date.now() - tA, tokens: 0, request }));
        return json({ jsonrpc: "2.0", id: rid, error: { code: -32000, message: "agent error, try again later" } }, 200, ah);
      }
    }

    // 终端访客：curl / wget / httpie 打首页 → ANSI 名片
    if (request.method === "GET" && url.pathname === "/" && /curl|wget|httpie/i.test(request.headers.get("user-agent") || "")) {
      return new Response(CURL_CARD, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    // 完整简历（中/英）：只认 send_resume 邮件里的签名链接（?k=）；首次打开记录 + 通知（线索热度信号）
    if (request.method === "GET" && (url.pathname === "/resume.pdf" || url.pathname === "/resume-en.pdf")) {
      const k = url.searchParams.get("k") || "";
      if (!env.DB || !/^[a-f0-9]{32}$/.test(k)) return new Response("not found", { status: 404 });
      const row = await env.DB.prepare(`SELECT * FROM resume_sends WHERE token=?1`).bind(k).first();
      if (!row || Date.now() - row.ts > 7 * 86400e3) return new Response("link expired", { status: 404 });
      if (!row.opened_ts) {
        const which = url.pathname === "/resume-en.pdf" ? "EN" : "中文";
        ctx.waitUntil((async () => {
          await env.DB.prepare(`UPDATE resume_sends SET opened_ts=?1 WHERE token=?2`).bind(Date.now(), k).run();
          await notify(env, "lead.new", `🔥 简历被打开 · ${SITE_HOST}`,
            `收件: ${row.email}（${which}版）\n回放: ${SITE.origin}/admin/session?id=${row.session_id}`);
        })().catch(() => {}));
      }
      return env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin)));
    }

    // 其余 GET → 前端静态文件
    if (request.method === "GET" || request.method === "HEAD") {
      return env.ASSETS.fetch(request);
    }

    // POST /api → AI proxy
    if (url.pathname !== "/api") {
      return json({ error: "not found" }, 404);
    }

    const origin = request.headers.get("origin") || "";
    const { headers: cors, ok: originOk } = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    // 浏览器请求带 Origin 时必须在白名单；无 Origin（curl 调试）放行，仍受限速约束
    if (origin && !originOk) return json({ error: "origin not allowed" }, 403, cors);

    const ip = request.headers.get("cf-connecting-ip") || "?";
    if (rateLimited(ip)) return json({ error: "slow down 🙂 try again in a minute" }, 429, cors);

    if (!env.DEEPSEEK_API_KEY) return json({ error: "DEEPSEEK_API_KEY secret not set" }, 500, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400, cors);
    }

    const q = String(body.q || "").trim().slice(0, MAX_Q);
    if (!q) return json({ error: "empty question" }, 400, cors);
    const lang = body.lang === "en" ? "en" : "zh";
    const sid = /^[A-Za-z0-9._-]{6,64}$/.test(String(body.sid || "")) ? String(body.sid) : "anon-" + (await ipHash(ip)).slice(0, 8);

    // 历史消息白名单式清洗：只收 user/assistant + 字符串 content
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG) }));

    const messages = [
      { role: "system", content: SYSTEM_PROMPT + `\n\n（本次访客界面语言 lang=${lang}）` },
      ...history,
      { role: "user", content: q },
    ];

    const t0 = Date.now();

    // —— 流式分支（前端 body.stream=true）——
    // SSE 事件：{t:"文本增量"} · {tool:"工具名"} · {done:true} · {error:"..."}
    if (body.stream === true) {
      const enc = new TextEncoder();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const send = (obj) => writer.write(enc.encode("data: " + JSON.stringify(obj) + "\n\n")).catch(() => {});
      ctx.waitUntil((async () => {
        let msgs = messages, full = "", tokens = 0;
        const toolsUsed = [];
        try {
          for (let round = 0; round < 3; round++) {
            const r = await fetch("https://api.deepseek.com/chat/completions", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
              body: JSON.stringify({
                model: "deepseek-chat",
                messages: msgs,
                max_tokens: MAX_TOKENS,
                temperature: 0.45,
                stream: true,
                stream_options: { include_usage: true },
                ...(round < 2 ? { tools: TOOLS } : {}),
              }),
              signal: AbortSignal.timeout(30_000),
            });
            if (!r.ok) {
              console.error("deepseek stream error", r.status);
              send({ error: `upstream ${r.status}` });
              full = full || `⚠ upstream ${r.status}`;
              break;
            }
            const res = await pumpDeepSeekStream(r.body, (d) => { full += d; send({ t: d }); });
            tokens += res.tokens;
            if (res.toolCalls.length && round < 2) {
              msgs = [...msgs, {
                role: "assistant",
                content: res.content || "",
                tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args || "{}" } })),
              }];
              for (const tc of res.toolCalls) {
                toolsUsed.push(tc.name);
                send({ tool: tc.name });
                let targs = {};
                try { targs = JSON.parse(tc.args || "{}"); } catch {}
                const result = await execTool(env, tc.name, targs, sid, request, { q });
                msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
              }
              continue;
            }
            break;
          }
          send({ done: true });
        } catch (e) {
          console.error("stream error", e?.message || e);
          send({ error: "stream interrupted" });
        } finally {
          await writer.close().catch(() => {});
          await afterExchange(env, {
            sid, q, lang, request, tokens,
            answer: (toolsUsed.length ? `[tools: ${toolsUsed.join(",")}] ` : "") + (full || "⚠ empty"),
            latency: Date.now() - t0,
          }).catch(() => {});
        }
      })());
      return new Response(readable, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...cors },
      });
    }

    try {
      const { answer, toolsUsed, tokens } = await runAgent(env, request, { q, lang, sid, history });
      if (!answer) return json({ error: "empty completion" }, 502, cors);
      const logged = (toolsUsed.length ? `[tools: ${toolsUsed.join(",")}] ` : "") + answer;
      ctx.waitUntil(afterExchange(env, { sid, q, answer: logged, lang, latency: Date.now() - t0, tokens, request }));
      return json({ answer, tools: toolsUsed }, 200, cors);
    } catch (e) {
      console.error("proxy error", e?.message || e);
      const status = e?.status ? 502 : 504;
      ctx.waitUntil(afterExchange(env, { sid, q, answer: `⚠ ${e?.message || "timeout"}`, lang, latency: Date.now() - t0, tokens: 0, request }));
      return json({ error: e?.message || "upstream timeout" }, status, cors);
    }
  },

  // 每日 Lark 日报（wrangler.toml 里的 cron 触发）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (!env.DB || !env.LARK_WEBHOOK) return;
        const dayAgo = Date.now() - 86400e3;
        const [s, m, l, qs] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE last_ts>=?1`).bind(dayAgo).first(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE role='q' AND ts>=?1`).bind(dayAgo).first(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ts>=?1`).bind(dayAgo).first(),
          env.DB.prepare(`SELECT content FROM messages WHERE role='q' AND ts>=?1 ORDER BY ts DESC LIMIT 5`).bind(dayAgo).all(),
        ]);
        const sample = (qs.results || []).map((r) => "· " + r.content.slice(0, 50)).join("\n");
        await notify(
          env,
          "daily.digest",
          `📊 ${SITE_HOST} 日报`,
          `会话 ${s?.n || 0} · 提问 ${m?.n || 0} · 新线索 ${l?.n || 0}\n` +
            (sample ? `最近的问题：\n${sample}\n` : "") +
            `后台: ${SITE.origin}/admin`
        );
      })()
    );
  },
};
