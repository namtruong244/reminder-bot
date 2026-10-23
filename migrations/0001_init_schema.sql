-- Bảng lưu thông tin người dùng và cấu hình đồng bộ iOS
CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
    icloud_apple_id TEXT,
    icloud_app_password_enc TEXT, -- Mã hóa AES-256-GCM
    icloud_calendar_url TEXT,     -- Endpoint CalDAV của list Nhắc nhở
    sync_token TEXT,              -- Dùng cho đồng bộ thay đổi từ iOS về Bot
    morning_brief_time TEXT DEFAULT '08:00',
    created_at TEXT DEFAULT (datetime('now'))
);

-- Bảng lưu trữ công việc / sự kiện
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,          -- UUID v4 (dùng chung làm UID cho CalDAV)
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_at TEXT NOT NULL,         -- Chuẩn ISO 8601 UTC (VD: 2026-10-21T08:00:00Z)
    remind_at TEXT NOT NULL,      -- Thời điểm bot sẽ bắn thông báo tiếp theo (ISO 8601 UTC)
    priority TEXT DEFAULT 'MEDIUM' CHECK(priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
    recurrence_rule TEXT,         -- Chuẩn RRULE (VD: FREQ=DAILY;INTERVAL=1)
    nagging_mode INTEGER DEFAULT 0, -- 1 = Nhắc lại mỗi 10 phút nếu chưa bấm Done (cho việc CRITICAL)
    snooze_count INTEGER DEFAULT 0,
    caldav_etag TEXT,             -- ETag để kiểm tra xung đột khi đồng bộ iCloud
    ios_synced INTEGER DEFAULT 0, -- 0 = Chưa đồng bộ, 1 = Đã đồng bộ
    last_notified_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id)
);

-- Index tối ưu hóa truy vấn cho Cron Trigger mỗi phút
CREATE INDEX IF NOT EXISTS idx_tasks_due_scan
ON tasks(status, remind_at);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status
ON tasks(user_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_ios_synced
ON tasks(ios_synced, status);
