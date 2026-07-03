# agentcard — 会接待访客的 AI 终端名片

一张会替主人接待、筛选、转化访客的 AI 名片：可玩终端 + 流式 AI + 真工具（留联/微信门控/发简历）+ 线索后台 + 飞书通知 + curl 名片 + A2A。
An AI business card that greets visitors for its owner: a playable terminal, streaming AI with real tools (contact intake / gated WeChat / resume delivery), a leads dashboard, Feishu notifications, a curl card, and A2A.

**这也是一个模板**——fork 之后改两个内容文件，就是你自己的 AI 名片。参考实例（live demo）：[whyiyhw.sh · ask.whyiyhw.com](https://ask.whyiyhw.com)。

```
resume/
├── index.html          # 前端：内容 + 样式 + 终端引擎（自包含，内容区改成你的）
├── worker/
│   ├── ai-proxy.js     # 引擎：AI 代理 / 工具 / 落库 / 后台 / 通知 / A2A（不用改）
│   ├── config.js       # ★ 内容：人设、事实基线、curl 名片、邮件模板、A2A 卡（改成你的）
│   ├── schema.sql      # D1 建表
│   ├── wrangler.toml.example  # 部署配置模板（域名 / D1 / 通知）→ cp 成 wrangler.toml（真值本地，gitignore）
│   └── assets/         # 部署产物：index.html 副本 + brief.pdf + og.png（resume*.pdf 本地生成、gitignore，不公开）
├── pdf-src/            # 简历 / 合作简介的 HTML 源（Chrome 出 PDF）
└── PRD.md              # 产品规划
```

## Fork 成为你的名片（十分钟）

> 最省事的方式：在 Claude Code 里打开本仓库，触发内置 skill **`agentcard-deploy`**（说「部署这个项目」或「我要自己的 AI 名片」），它会访谈你、逐步把下面这些做完，并顺带讲清设计理念与安全模型。手动步骤如下：

0. **起手**：`cp worker/wrangler.toml.example worker/wrangler.toml` + `cp worker/.dev.vars.example worker/.dev.vars`（真实配置只在本地，已 gitignore，不进仓库）
1. **改内容**：`worker/config.js`（人设 prompt、事实、域名、邮箱、curl 名片、A2A 卡）+ `index.html` 的 HTML 内容区（hero 文案、作品卡、能力、联系方式）+ `pdf-src/` 重新出 PDF
2. **改配置**：`worker/wrangler.toml` —— Worker 名、自定义域名、`ALLOWED_ORIGINS`、`FEISHU_*`（或换 slack/discord/ntfy/template）
3. **建库**：`npx wrangler d1 create ask-db` → 填 `database_id` → `npx wrangler d1 execute ask-db --remote --file=schema.sql`
4. **灌 secrets**：`DEEPSEEK_API_KEY`（必填）· `ADMIN_TOKEN`（必填）· `WECHAT_ID` / `MAILERSEND_API_KEY`（或 `RESEND_API_KEY`）/ `FEISHU_APP_SECRET`（按需）
5. **上线**：`./worker/deploy.sh`

## A2A：让别人的 agent 也能来递名片

- 发现：`GET /.well-known/agent-card.json`
- 对话：`POST /a2a`（JSON-RPC 2.0，`message/send`；带 `contextId` 自动续多轮，历史存 D1）

```bash
curl -s https://ask.whyiyhw.com/a2a -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"message/send",
  "params":{"message":{"role":"user","parts":[{"kind":"text","text":"is he a fit for an IoT gateway project?"}]}}
}'
```

## 玩法 / How to use

本地：`python3 -m http.server 8080` → http://localhost:8080 （或直接双击 `index.html`）

终端里可输入：`help` · `whoami` · `skills` · `iot` · `ls` · `open seek` · `ask <问题>` · `theme` · `lang` · `clear`
支持命令历史（↑ / ↓）、深浅切换、中英切换。加 `#demo` 打开会自动跑几条命令做演示。

## 让 `ask` 变成真的 DeepSeek agent

前端 **不能** 放 DeepSeek key（会被扒出来盗刷）。`worker/` 里是持有 key 的代理，三步上线：

```bash
cd worker
npx wrangler deploy                        # 1. 部署 → 得到 https://ask.<子域>.workers.dev
npx wrangler secret put DEEPSEEK_API_KEY   # 2. 粘贴 key（只存 Cloudflare secret，不进仓库/前端）
```

3. 把 `index.html` 里的 `AI_ENDPOINT = ""` 改成第 1 步的 Worker URL。刷新后状态栏 `agent` 变为 `deepseek`，`ask` 即为在线 AI（带多轮上下文）。

上线正式域名后，把 `worker/wrangler.toml` 的 `ALLOWED_ORIGINS` 改成你的站点域名（逗号分隔），再 `npx wrangler deploy` 一次。

内置防滥用：CORS 白名单、每 IP 每分钟 10 次、问题 ≤500 字、回答 ≤500 token。
Worker 挂了或没配时，`ask` 自动回退本地脚本应答，页面不会坏。

## P0：后台 + 线索通知（谁来了、聊了什么、有人想合作马上知道）

```bash
cd worker
npx wrangler d1 create ask-db                        # ① 建库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 execute ask-db --remote --file=schema.sql   # ② 建表
npx wrangler secret put ADMIN_TOKEN                  # ③ /admin 的钥匙（自己编一串长随机字符）
npx wrangler secret put LARK_WEBHOOK                 # ④ 可选：飞书机器人 / 流程 webhook（其他平台也行）
./deploy.sh                                          # ⑤ 上线
```

之后你拥有：

- **后台** `https://ask.whyiyhw.com/admin?t=<ADMIN_TOKEN>`：今日会话/提问、7 天线索、会话列表 + 完整对话回放（终端风格）
- **实时通知**：访客留下联系方式或表达合作意向时推送（每会话最多 3 条防刷屏）
- **日报**：每天北京时间 09:00 推会话数/提问数/新线索 + 最近问题
- 通知机制与 seek 一致（`webhook.go` + `feishu_bot.go`）。`LARK_FORMAT="feishu"` = 飞书**企业自建应用 bot** 走 IM API：`tenant_access_token` 缓存（7200s、提前 5 分钟刷新、单飞）、`content` 双重编码、**HTTP 200 + 非零 code 视为真错误**、token 失效码自动刷新重试。配置：`wrangler.toml` 填 `FEISHU_APP_ID` / `FEISHU_RECEIVE_ID`（群=chat_id / 私聊=open_id），`npx wrangler secret put FEISHU_APP_SECRET`。其他平台：`slack` / `discord` / `ntfy` / `template` / `raw` 走 `LARK_WEBHOOK` URL
- 验证通知链路：开 `https://ask.whyiyhw.com/admin/probe?t=<ADMIN_TOKEN>`，飞书收到「✅ 通知测试」即通；失败原因看 `npx wrangler tail ask`
- **隐私**：IP 只存截断哈希；页脚有一行记录声明；`sid` 是前端随机 uuid，不含个人信息
- **微信号已下架**：页面、终端、AI 提示词里都没有明文微信号——访客想加微信，agent 会请对方留下联系方式，由你主动加回（线索同时进后台 + Lark）

不绑 D1 也能跑：所有落库/通知都是旁路（`waitUntil`），挂了不影响回答。

## P1：Agent 工具化（function calling）

agent 有三个真工具（DeepSeek tools，Worker 侧执行，终端里可见 `[agent] → xxx ✓`）：

| 工具 | 触发 | 防线 |
|---|---|---|
| `leave_contact` | 访客留下联系方式+来意 | 落 `leads`（source=tool）+ 推送通知 |
| `offer_wechat` | 访客要微信号 | **微信号存 secret `WECHAT_ID`，不进 prompt**；门控=对方必须已留过联系方式；每会话最多放行 2 次 |
| `send_brief` | 访客想快速了解 | 返回 `/brief.pdf`（一页合作简介，人人可得） |
| `send_resume` | 访客诚心要完整简历 + 给了邮箱 | 完整简历发对方邮箱。**四重门控**：邮箱必须是访客自己在对话里敲的（模型编不出没出现过的地址）· 同邮箱 7 天不重发 · 每会话 1 次 · 全局每日 ≤10。邮件为固定模板（无注入面），`Reply-To` 指向 whyiyhw@outlook.com（对方回信直达本人）。简历链接带随机 token、7 天有效，**被打开时飞书推 🔥 通知**——最热的线索信号 |

启用：

```bash
cd worker
npx wrangler secret put WECHAT_ID   # 值=你的微信号；不配则 offer_wechat 永远拒绝
./deploy.sh
```

### send_resume 启用步骤（MailerSend / Resend 任选，代码两家都支持，优先 MailerSend）

1. 注册 [MailerSend](https://www.mailersend.com)（或 [Resend](https://resend.com)）→ 添加并验证你的**发件域名** → 按提示在 DNS 加 SPF/DKIM 记录 → 等验证通过
2. 后台生成 API Key → `npx wrangler secret put MAILERSEND_API_KEY`（用 Resend 则 `RESEND_API_KEY`）
3. 建 `resume_sends` 表：`npx wrangler d1 execute ask-db --remote --file=schema.sql`（IF NOT EXISTS，重跑安全）
4. `./deploy.sh`
5. （可选双保险）Cloudflare → Email Routing：把发件地址转发到你的邮箱——邮件本身已带 `Reply-To`，这一步只防有人手动抄 From 地址写信

隐私：完整简历 PDF **无手机号、无薪资、无微信号**；不走签名链接直接访问 `/resume.pdf` 一律 404。

> ⚠️ 本仓库**不含** `resume.pdf` / `resume-en.pdf`（已 gitignore）——否则任何人能从 GitHub raw 直接下载，绕过上面的邮箱门控。fork 后按下面步骤**自己生成**，PDF 随部署上线、不进公开仓库。`brief.pdf`（人人可得的一页简介）随仓库提供作示例。

PDF 源文件在 `pdf-src/`（本仓库随附 `brief.html` 作示例；完整简历源 `resume.html` / `resume-en.html` 同 PDF 一样不进公开仓库，fork 后照 `brief.html` 的结构自建），改完用 Chrome 重新出 PDF：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --print-to-pdf=worker/assets/resume.pdf --no-pdf-header-footer pdf-src/resume.html
```

### 本地联调（不动线上、不改代码）

1. 在 `worker/.dev.vars`（已 gitignore）里填入你的 key：`DEEPSEEK_API_KEY=sk-xxx`
2. 终端 1：`cd worker && npx wrangler dev` → Worker 跑在 http://localhost:8787
3. 终端 2：`python3 -m http.server 8080` → 打开 http://localhost:8080
4. 浏览器控制台执行：`localStorage.ai_endpoint="http://localhost:8787"; location.reload()`
   状态栏 `agent` 变 `deepseek`，`ask` 即为真 DeepSeek。恢复：`localStorage.removeItem("ai_endpoint"); location.reload()`

也可以直接 curl 验 Worker：

```bash
curl -s http://localhost:8787 -H 'content-type: application/json' \
  -d '{"q":"他 IoT 做过什么？","lang":"zh"}'
```

## 部署 / Deploy

**GitHub Pages** — 推送后 Settings → Pages 选 `main` / `/ (root)`。
**Cloudflare Pages** — 连接仓库，Build command 留空，输出目录 `/`（纯静态）。同平台还能顺手放上面的 AI Worker。

## 自定义

- 文案：`index.html` 内，中英用 `<span class="zh">` / `<span class="en">`，html 上的语言标记用 `lang-en`（不能用 `en`，会和内容规则撞）。
- 配色：`:root` 里的 CSS 变量（主色 `--amber`，次色 `--cyan`）。
- 隐私：手机号、薪资未公开。
