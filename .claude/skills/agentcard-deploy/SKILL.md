---
name: agentcard-deploy
description: Deploy and personalize your own agentcard — the AI business-card terminal in this repo. Use when someone has cloned or forked this project and wants to stand up their own instance, replace the demo content with their own, configure the Cloudflare Worker + DeepSeek + D1 + Feishu/Lark notifications, regenerate the resume PDFs, or understand the project's design philosophy and security model. Triggers include "部署这个项目", "我要自己的 AI 名片", "配置 worker", "讲讲这个项目的设计理念", "换成我的内容", "deploy agentcard", "set up my own AI business card", "fork this repo", "personalize the card", "how does the security work".
---

# agentcard-deploy — 带 fork 者把这张 AI 名片变成他自己的

> 一句话:这不是一张静态简历页,是**一张会替主人接待、筛选、转化访客的 AI 终端名片**。访客来了,它自我介绍、回答问题、识别是不是有合作意向、捕获线索并通知主人。这个 skill 带用户把 demo 里的内容换成他自己的,并把后端配起来。
>
> This is not a static résumé page — it's an **AI business card that greets, screens, and converts visitors** on the owner's behalf. This skill walks a forker through replacing the demo content and wiring up the backend.

**给 AI 的执行原则:** 一步步来,每一步做完让用户确认再往下。**不要**用占位符批量覆盖用户内容——先访谈,拿到用户的真实信息再写。命令一律在 `worker/` 或仓库根目录跑,涉及 secret 的让用户自己执行(你不经手任何 key)。

---

## 0. 先说清楚这东西是什么、为什么这么设计(理念 + 安全模型)

部署前先让用户理解设计,不然改起来会踩坑:

**定位。** 北极星是「每月有效合作线索」。不是博客(内容)、不是求职页(投递),而是:展示品味 → 回答问题 → 识别合作意向 → 捕获线索。终端世界观本身自带传播点(访客会截图)。

**安全是结构性的,不是靠 prompt 求模型「别说」。** 这是整个项目最该被继承的部分:

- **DeepSeek key 只存 Worker secret,永远不进前端。** 前端放 key = 当场被扒出来盗刷。前端只调 `AI_ENDPOINT`,key 在 `ai-proxy.js` 里从 `env` 读。
- **微信号只在 secret `WECHAT_ID`,经 `offer_wechat` 工具服务端门控发放。** 明文不进 system prompt、不进页面——所以再怎么 prompt 注入也套不出来。门控:访客必须**先留下自己的联系方式**,服务端校验通过才返回;每会话最多放行 2 次。
- **完整简历 `send_resume` 四重门控:** 邮箱必须是访客**亲手在对话里敲的**(模型编不出没出现过的地址)· 同邮箱 7 天不重发 · 每会话 1 次 · 全局每日 ≤10。邮件是固定模板 = 零注入面;不做任何自由外发邮件。
- **隐私红线:** IP 只存 SHA-256 截断哈希;完整简历 PDF 无手机号 / 无薪资 / 无微信号;直接访问 `/resume.pdf` 无签名 token 一律 404。

**内容 / 引擎分离(fork 的核心契约)。** 你只需要改三处内容,引擎不用碰:
- `worker/config.js` —— 人设、事实基线、curl 名片、邮件模板、A2A 卡(**全部个人内容在这**)
- `index.html` 的 HTML 内容区 —— hero 文案、作品卡、能力、联系方式
- `pdf-src/` —— 简历 / 合作简介的 HTML 源,重出 PDF
- **`worker/ai-proxy.js` 是引擎,不用改**(AI 代理 / 工具 / 落库 / 后台 / 通知 / A2A;所有对主人的引用都从 `config.js` 的 `SITE` 派生)。

**A2A(差异点)。** 别人的 agent 可以直接发现并询问你的名片:`GET /.well-known/agent-card.json` 发现 + `POST /a2a`(JSON-RPC message/send,带 contextId 自动多轮)。人不在场,两个 agent 先把匹配度聊完。

**兜底。** AI 挂了 / 没配 key 时,`ask` 自动回退本地脚本应答,页面永不白屏。所有落库 / 通知都走 `waitUntil` 旁路,挂了不影响回答。

---

## 1. Preflight(环境 + 从模板起手)

```sh
node -v            # 需要 Node 18+
npx wrangler --version
cd worker
cp wrangler.toml.example wrangler.toml   # 真实配置(域名/Feishu/D1)在这里改,已被 gitignore
cp .dev.vars.example .dev.vars           # 本地联调用,填你的 DEEPSEEK_API_KEY,已被 gitignore
```

> `wrangler.toml` 和 `.dev.vars` 都在 `.gitignore` 里——真值只在你本地,永不进仓库。仓库只提供 `.example` 模板。

---

## 2. 个性化内容(访谈式,别用占位符糊)

**先问用户,拿到真实信息再改。** 需要收集:姓名 / handle / 站点域名 / 邮箱 / GitHub / blog;一句话定位;3–5 个代表作(名字 + 一句话 + 链接);关键能力与真实数字(项目里的量化成绩最有说服力);语气偏好。

改这三处:
1. **`worker/config.js`**
   - `SITE`:`origin`(你的域名)、`name`、`agentName`、`owner{name,id,email,github,blog}`
   - `SYSTEM_PROMPT`:人设 + **事实基线**(公司、职责、量化成绩、代表作)。这是 agent 回答的唯一事实来源,越具体越可信;宁缺毋编。
   - `CURL_CARD`、`RESUME_MAIL`、`AGENT_CARD` 里的名字 / 链接 / 简介一并换掉。
2. **`index.html` 内容区**:hero、作品卡、能力、联系方式。双语用 `<span class="zh">` / `<span class="en">`;配色改 `:root` 的 `--amber` / `--cyan`。**改完 index.html 必须同步到 assets(见第 6 步),否则 CI 校验会失败。**
3. **`pdf-src/`**:改 `resume.html` / `resume-en.html` / `brief.html`,用 Chrome headless 重出 PDF:
   ```sh
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
     --print-to-pdf=worker/assets/resume.pdf --no-pdf-header-footer pdf-src/resume.html
   ```
   ⚠️ **康熙部首坑:** macOS Chrome `--print-to-pdf` 会把汉字渲染成康熙部首(⼯⻔ 而非 工门),AI/ATS 关键词匹配直接失效。`pdf-src` 里已内嵌 Noto Sans SC webfont 修掉它——**别删那个 `@font-face`**。出完 PDF 抽一页文字确认汉字正常(用 PyMuPDF 或 pdfminer,别用 pypdf——它会在 CJK 间插空格造成误判)。

---

## 3. Cloudflare:D1 + 域名

```sh
npx wrangler login
npx wrangler d1 create ask-db          # 把输出的 database_id 粘进 wrangler.toml 的 [[d1_databases]]
npx wrangler d1 execute ask-db --remote --file=schema.sql   # 建表:sessions/messages/leads/resume_sends
```
域名:在 Cloudflare 把你的域名接进来,改 `wrangler.toml` 的 `routes[].pattern`;没有域名可删掉 routes 块,用 `*.workers.dev`。
> 不想要后台 / 日志?把 `[[d1_databases]]` 整块注释掉,站点照常工作(落库是旁路)。

---

## 4. Secrets(让用户自己执行,你不经手 key)

```sh
npx wrangler secret put DEEPSEEK_API_KEY   # 必填
npx wrangler secret put ADMIN_TOKEN        # 必填:/admin 的钥匙,自己编一串长随机字符
# 按需:
npx wrangler secret put WECHAT_ID          # 不配则 offer_wechat 永远拒绝(没有微信号可放行)
npx wrangler secret put MAILERSEND_API_KEY # 或 RESEND_API_KEY —— send_resume 发信;发件域名需先在对应平台验证
npx wrangler secret put FEISHU_APP_SECRET  # 走飞书通知时
```

---

## 5. 配置 wrangler.toml(通知渠道)

`[vars]` 里:
- `ALLOWED_ORIGINS`:改成你的正式域名(逗号分隔,CORS 白名单)。
- 通知渠道 `LARK_FORMAT`:`feishu`(企业自建应用 bot 走 IM API,填 `FEISHU_APP_ID` / `FEISHU_RECEIVE_ID`,群= `oc_` chat_id / 私聊= `ou_` open_id)· 或 `slack` / `discord` / `ntfy` / `template` / `raw`(走 `LARK_WEBHOOK` secret 的 URL)。
- `RESEND_FROM` / `REPLY_TO`:发件人与回信直达地址。

---

## 6. 部署

```sh
./deploy.sh     # = sync-assets.sh(把根 index.html 同步进 assets/) + wrangler deploy
```
> **必须走 `deploy.sh` 或先跑 `sync-assets.sh`**:仓库有 CI(`.github/workflows/assets-sync.yml`)校验 `index.html` 与 `worker/assets/index.html` 一致,不同步会红。

前端最后一步:把 `index.html` 里的 `AI_ENDPOINT` 改成你的 Worker 地址,`ask` 才是在线 AI(否则回退脚本应答)。

---

## 7. 验证

- 通知链路:开 `https://<你的域名>/admin/probe?t=<ADMIN_TOKEN>`,渠道收到「✅ 通知测试」即通;失败看 `npx wrangler tail`。
- 后台:`https://<你的域名>/admin?t=<ADMIN_TOKEN>` 有会话列表 / 回放。
- AI:站点里问一句,或 `curl -s https://<你的域名>/api -H 'content-type: application/json' -d '{"q":"介绍一下你自己","lang":"zh"}'`。
- A2A:`curl -s https://<你的域名>/.well-known/agent-card.json`;再 `POST /a2a` 发一条 `message/send`。
- 本地联调(不动线上):`npx wrangler dev`(:8787)+ `python3 -m http.server 8080`,浏览器控制台 `localStorage.ai_endpoint="http://localhost:8787"; location.reload()`。

---

## 8. 回馈

改进了引擎 / 修了坑?欢迎回 PR 到上游。个人内容(`config.js` / `index.html` / `pdf-src/` / `assets/`)不用回贡——那是你的名片。

---

## 附:文件地图

| 路径 | 角色 | fork 时 |
|---|---|---|
| `worker/config.js` | ★ 内容:人设/事实/curl 名片/邮件/A2A 卡 | **改成你的** |
| `index.html`(内容区) | 前端文案 + 作品 + 联系方式 | **改成你的** |
| `pdf-src/*.html` | 简历 / 简介 HTML 源 | **改成你的** → 重出 PDF |
| `worker/wrangler.toml` | 域名 / D1 / 通知配置 | 从 `.example` 复制后改 |
| `worker/ai-proxy.js` | 引擎:AI 代理/工具/落库/后台/通知/A2A | **不用碰** |
| `worker/schema.sql` | D1 建表 | 直接用 |
