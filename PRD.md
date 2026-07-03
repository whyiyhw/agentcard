# PRD · whyiyhw.sh — 会接待访客的 AI 终端名片

> 状态:v1.1(2026-07-02) · Owner:whyiyhw(薛异) · 起草:whyiyhw-agent 项目组
>
> **进度:P0 ✅ · P1 ✅ · P1.5 ✅(全部上线并端到端验证)** · 体验层已加:SSE 流式、curl 名片、成就系统、中英双版简历
> 实现备注:通知走飞书企业自建应用 bot(IM API,流程应用已被飞书下架);邮件走 MailerSend;工具共 4 个(leave_contact / offer_wechat / send_brief / send_resume)

## 1. 一句话定位

**一张会替主人接待、筛选、转化访客的 AI 名片。**
不是简历页(求职),不是博客(内容),而是:展示品味 → 回答问题 → 识别合作意向 → 捕获线索。

## 2. 为什么值得做成产品

- 它已经有产品三要素:用户(访客)、数据(对话)、转化目标(合作线索)。
- 「AI 名片」是个空位:Linktree 解决了链接聚合,没人解决"我睡觉时替我聊天的名片"。
- 分发能力已验证:chatgpt-wechat 1.2k★ 说明作者有开源冷启动能力;终端世界观自带传播点(访客会截图)。
- 技术栈极轻:1 个 HTML + 1 个 Worker,任何人 `wrangler deploy` 即拥有 —— 天然适合开源模板。

## 3. 角色

| 角色 | 诉求 |
|---|---|
| 访客(潜在合作方/同行) | 快速判断这个人能不能干活、值不值得聊 |
| 主人(whyiyhw) | 不错过线索;知道访客问了什么以便调优;隐私分级 |
| 部署者(开源后) | 十分钟拥有自己的 AI 名片,不碰前端代码 |

## 4. 北极星指标

**每月有效合作线索数**(访客留下联系方式 + 明确需求)。
辅助:会话数、人均 turns(粘性)、`ask` 占比、线索转化率(线索/会话)。

## 5. 功能规划

### P0 · 可观测 + 线索闭环(一个周末)

**5.1 会话落库(D1)**
- 表 `sessions`:id(前端 uuid,localStorage 持久)、first_ts、country、city、ua、lang、referer
- 表 `messages`:session_id、ts、role(q/a)、content、latency_ms、tokens
- 隐私红线:IP 只存 SHA-256 截断哈希;默认保留 90 天;页脚一行隐私声明
- cf 对象白嫖地理信息(`request.cf.country/city`),不接第三方统计

**5.2 /admin 后台(Worker 直出 HTML)**
- `ADMIN_TOKEN` secret 保护(URL ?token= 或 Basic Auth)
- 列表:最近会话(时间、地区、turns、首问);详情:完整对话回放
- 顶部三个数:今日会话 / 今日提问 / 本周线索
- 不引任何第三方 JS,风格延用终端 UI(本身就是展品)

**5.3 Lark 通知(`LARK_WEBHOOK` secret)**
- 实时:访客留下联系方式或表达合作意向 → 卡片消息(地区、需求摘要、对话链接)
- 每日摘要(Worker Cron Trigger):会话数、top 问题、新线索数

**5.4 微信号下线**
- 从 system prompt、页面、scripted 兜底中全部移除明文微信号（改由 offer_wechat 工具服务端门控发放）
- 话术统一为:「留下你的邮箱 + 需求,他会主动联系你」

### P1 · Agent 工具化(function calling,一周)

DeepSeek tools 接入,Worker 侧执行,前端终端可视化工具调用过程(`[agent] → notify_owner ✓`)——工具执行动画本身就是 AI 工程能力的展示。

| 工具 | 行为 | 防线 |
|---|---|---|
| `leave_contact(contact, pitch)` | 落库 + Lark 实时推送 | 频率限制;contact 格式校验 |
| `offer_wechat()` | 服务端判定后返回微信号 | 微信号**不进 prompt**;需满足:访客已留自己联系方式 + 服务端意图分类=合作;每 IP 每日一次 |
| `send_brief()` | 返回合作简介 `brief.pdf` 链接 | 静态文件,无隐私字段(无电话/薪资) |

- `brief.pdf`:一页合作简介(能做什么 / 代表作 / 联系方式),人人可得
- **P1.5 · send_resume(v1.1 修订原「不发邮件」决策)**:诚心访客可获完整简历(中英双版)发至其邮箱。与「任意外发邮件」的本质区别 = 结构性门控:邮箱必须是访客亲手在对话里敲的 · 固定模板零注入面 · 同邮箱 7 天不重发 · 每会话 1 次 · 全局每日 ≤10 · 签名链接 7 天有效 · 打开即通知主人(🔥 最热线索信号)· Reply-To 直达主人邮箱

### P2 · 开源与服务化(验证后)

**5.5 内容与引擎分离(开源前置条件)**
- `persona.md`(人设与语气)+ `facts.md`(事实基线)+ `site.json`(名字/配色/命令/作品)
- 仓库剥离 whyiyhw 个人内容,个人内容走 config;`resume-base-*.md` 移出仓库
- README:十分钟部署指南(fork → 填 config → wrangler deploy)

**5.6 开源发布**
- 起名(候选:`agentcard` / `card.sh` / `hire.sh`,待定)、demo 站、发布(V2EX/HN/即刻)
- 成功信号:两周 500★ 或 10 个自部署实例 → 再考虑 hosted

**5.7 A2A:让别人的 agent 也能递名片(P2.5,开源发布的差异化卖点)**

背景:A2A(Agent2Agent,Google 发起、Linux Foundation 托管)定义了 agent 间发现与通信——而它的发现机制恰好叫 **Agent Card**(`/.well-known/agent-card.json`)。一张「人的 AI 名片」支持 A2A,概念上是闭环的终局:**招聘方/采购方的 agent 可以直接发现并询问 whyiyhw-agent**,人不在场,两个 agent 先把匹配度聊完。

- 实现为薄适配层(周末量级),复用现有 /api 管线:
  - `GET /.well-known/agent-card.json`:静态卡(name/description/skills=介绍主人·收线索·发简介/capabilities.streaming=true/url=/a2a)
  - `POST /a2a`:JSON-RPC `message/send`(+ `message/stream` 走 SSE)→ 映射为 q → 现有 agent 管线 → 回 A2A Message(无状态 message 模式,不做 Task 生命周期)
  - 限速/落库沿用,`source=a2a` 标记,后台可分流量看「机器访客」
- 卖点:开源标题可以写「第一张支持 A2A 的个人名片」;演示脚本:用另一个 A2A 客户端问"is he a fit for an IoT project?"
- 风险与对策:协议仍在演进 → 适配层保持薄,不深耦合;A2A 调用烧模型配额 → 与 /api 共享限速;垃圾 agent 爬取 → 每日全局上限
- 远期(P3 备选):同一管线再暴露一个 MCP server,让开发者把这张名片挂进自己的 Claude/IDE

**5.8 Hosted 服务(远期,验证后再动)**
- 多租户 Worker、控制台、自定义域名、按量计费(模型 key 托管)
- 在开源热度验证前**不投入**

## 6. 非功能需求

- 防滥用:已有(CORS 白名单、每 IP 10 次/分、输入 500 字、输出 500 token);P1 酌情加 Turnstile(无感验证)
- 成本:DeepSeek off-peak + 500 token 上限,预估 < ¥10/月;D1/Worker 免费额度内
- 可用性:AI 挂了自动回退本地脚本应答(已有),页面永不白屏

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| Prompt 注入套微信号/提示词 | 敏感信息(微信号)只存服务端工具,模型无明文;提示词泄露仅损失趣味性,可接受 |
| 对话日志隐私争议 | 页脚声明 + IP 哈希 + 90 天保留 + admin 仅 token 访问 |
| 高频刷接口烧 key | 限速已有;异常量 Lark 告警;极端情况 Worker 一键下线 AI 只留脚本应答 |
| 开源后被批量部署刷 DeepSeek | 部署者自带 key,与我无关;模板默认带全部防线 |

## 8. 里程碑

- ~~**M1**:P0 全量上线,飞书收到第一条真实线索通知~~ ✅ 2026-07-02
- ~~**M2**:P1 工具化上线,微信号进入服务端门控~~ ✅ 2026-07-02(含 P1.5 send_resume 中英双版 + 流式 + curl 名片 + 成就系统)
- **M3**:~~内容/引擎分离~~ ✅ + ~~A2A~~ ✅ 2026-07-02(`worker/config.js` 承载全部个人内容;`/.well-known/agent-card.json` + `/a2a` message/send 已上线,contextId 走 D1 实现多轮;LICENSE/fork 指南/隐私隔离就绪)。**待办:定名 → GitHub 发布 → 发帖**(V2EX/HN/即刻)
- M4:视 M3 反馈决定 hosted

## 9. 开放问题

1. 开源名字与独立域名?
2. brief.pdf 的内容与设计(终端风格延续?)
3. 日志保留期 90 天是否合适?
4. Turnstile 现在加还是被刷了再加?
