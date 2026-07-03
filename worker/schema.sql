-- ask.whyiyhw.com P0：会话落库
-- 应用：npx wrangler d1 execute ask-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS sessions (
  id       TEXT PRIMARY KEY,          -- 前端 localStorage 里的 uuid
  first_ts INTEGER NOT NULL,          -- ms
  last_ts  INTEGER NOT NULL,
  country  TEXT,
  city     TEXT,
  ua       TEXT,
  lang     TEXT,
  ip_hash  TEXT,                      -- SHA-256 截断，不存明文 IP
  turns    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  role       TEXT NOT NULL,           -- 'q' | 'a'
  content    TEXT NOT NULL,
  latency_ms INTEGER,
  tokens     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts);

CREATE TABLE IF NOT EXISTS leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ts         INTEGER NOT NULL,
  contact    TEXT,                    -- 命中的邮箱/手机/微信号（可空）
  pitch      TEXT,                    -- 触发的原话
  source     TEXT                     -- 'auto'（P0 关键词检测）/ 'tool'（P1 function calling）
);
CREATE INDEX IF NOT EXISTS idx_leads_ts ON leads(ts);

-- P1.5：send_resume 发送记录（专属链接 + 打开追踪）
CREATE TABLE IF NOT EXISTS resume_sends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ts         INTEGER NOT NULL,
  email      TEXT NOT NULL,
  token      TEXT NOT NULL,               -- 邮件里专属链接的随机 token（7 天有效）
  opened_ts  INTEGER                      -- 首次打开时间（线索热度信号）
);
CREATE INDEX IF NOT EXISTS idx_resume_token ON resume_sends(token);
CREATE INDEX IF NOT EXISTS idx_resume_email ON resume_sends(email, ts);
