# AGENT.MD — Telegram Smart Reminder Bot (Cloudflare Workers + D1 + iOS Reminders)

## 1. Tổng quan Dự án (Project Overview)

Dự án xây dựng một trợ lý cá nhân thông minh trên **Telegram**, vận hành hoàn toàn Serverless trên **Cloudflare Workers** và lưu trữ dữ liệu tại **Cloudflare D1 (SQLite)**.

Hệ thống sử dụng LLM để phân tích ngôn ngữ tự nhiên tiếng Việt (tin nhắn văn bản hoặc giọng nói), tự động bóc tách thông tin công việc/sự kiện, lưu vào D1 Database, đồng bộ hai chiều với **iOS Reminders / Apple Calendar** và chủ động gửi thông báo nhắc việc (Push Notification) qua Telegram kèm các nút tương tác nhanh (Inline Keyboard).

## 2. Kiến trúc & Công nghệ (Tech Stack)

* **Runtime & Hosting:** Cloudflare Workers (TypeScript, ES Modules).

* **Framework định tuyến:** `Hono` (siêu nhẹ, tối ưu cho Cloudflare Workers).

* **Cơ sở dữ liệu:** Cloudflare D1 (SQLite ở tầng Edge) + `Drizzle ORM` (hoặc Raw SQL prepared statements).

* **Lập lịch (Scheduling):** Cloudflare Cron Triggers (`scheduled` event chạy mỗi phút `* * * * *` và theo khung giờ cố định).

* **Telegram Bot SDK:** `grammY` (hỗ trợ sẵn adapter cho Cloudflare Workers) hoặc gọi trực tiếp Telegram Bot HTTP API qua `fetch`.

* **AI / NLP Engine:** Google Gemini Flash API sử dụng tính năng **Structured Outputs (JSON Schema)** để trích xuất thực thể thời gian và công việc.

* **Đồng bộ iOS (iOS Sync Layer):**

  * **Phương thức 1 (Cloud-to-Cloud):** Giao thức CalDAV (`VTODO` / `VEVENT`) kết nối trực tiếp tới `https://caldav.icloud.com` bằng `fetch` XML/WebDAV (không phụ thuộc Node.js native modules).

  * **Phương thức 2 (Native iOS Bridge - Dự phòng cho iCloud Reminders thế hệ mới):** REST API Endpoint trên Worker kết hợp với **iOS Shortcuts** để đồng bộ trực tiếp vào app Reminders trên iPhone.

## 3. Cấu trúc Thư mục (Directory Structure)

Khi khởi tạo code, AI Agent cần tuân thủ cấu trúc thư mục sau:

```
telegram-reminder-bot/
├── src/
│   ├── index.ts                 # Entrypoint: xử lý HTTP Webhook & Cron Trigger
│   ├── types/
│   │   ├── env.ts               # Định nghĩa Bindings (D1, Secrets, Variables)
│   │   └── task.ts              # Interfaces cho Task, NLP Payload, CalDAV
│   ├── bot/
│   │   ├── webhook.ts           # Xử lý Telegram Update (message, callback_query)
│   │   ├── keyboards.ts         # Định nghĩa Inline Keyboards (Done, Snooze, Cancel)
│   │   └── commands.ts          # Xử lý các lệnh /start, /list, /today, /sync
│   ├── services/
│   │   ├── nlp.service.ts       # Gọi LLM API phân tích câu chat ra JSON
│   │   ├── task.service.ts      # CRUD thao tác với Cloudflare D1
│   │   ├── icloud.service.ts    # Đồng bộ CalDAV (VTODO/VEVENT) với Apple iCloud
│   │   └── notifier.service.ts  # Logic quét task đến hạn & gửi push Telegram
│   └── utils/
│       ├── datetime.ts          # Xử lý múi giờ Asia/Ho_Chi_Minh (+07:00)
│       └── crypto.ts            # Mã hóa AES-GCM cho App-Specific Password
├── migrations/
│   └── 0001_init_schema.sql     # File khởi tạo bảng cho Cloudflare D1
├── wrangler.toml                # Cấu hình Cloudflare Workers, D1, Cron
├── package.json
└── tsconfig.json

```

## 4. Thiết kế Cơ sở dữ liệu (Cloudflare D1 Schema)

File migration `migrations/0001_init_schema.sql` phải bao gồm các bảng và chỉ mục (Index) tối ưu cho việc quét Cron mỗi phút:

```
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

```

## 5. Luồng Nghiệp vụ Chi tiết (Core Workflows)

### Luồng 1: Tiếp nhận & Phân tích Ngôn ngữ Tự nhiên (NLP Ingestion Flow)

1. **User** nhắn tin vào Telegram Bot (ví dụ: *"Nhắc tôi 3h chiều mai gửi hợp đồng cho khách, việc gấp nhé"*).

2. **Cloudflare Worker** nhận payload qua POST `/webhook/telegram`.

3. Kiểm tra bảo mật header `X-Telegram-Bot-Api-Secret-Token`.

4. Worker gửi nội dung tin nhắn kèm thời gian hiện tại (theo múi giờ `Asia/Ho_Chi_Minh`) vào `nlp.service.ts`.

5. **LLM** phân tích và trả về định dạng JSON nghiêm ngặt:

   ```
   {
     "intent": "CREATE_TASK",
     "title": "Gửi hợp đồng cho khách",
     "description": null,
     "due_at_iso": "2026-10-22T15:00:00+07:00",
     "remind_before_minutes": 15,
     "priority": "CRITICAL",
     "nagging_mode": true,
     "recurrence_rrule": null
   }
   
   ```

6. Worker chuyển đổi thời gian về UTC, lưu bản ghi vào bảng `tasks` trong **D1 Database** (sử dụng `ctx.waitUntil()` cho các tác vụ nền để phản hồi Telegram nhanh dưới 1 giây).

7. Worker gọi `icloud.service.ts` để đẩy task lên iOS Reminders.

8. Bot trả lời xác nhận trên Telegram kèm thông tin chi tiết và nút bấm `[✏️ Sửa giờ]` `[🗑 Hủy]`.

### Luồng 2: Đồng bộ với iOS Reminders (iOS Synchronization Flow)

> **Lưu ý kỹ thuật quan trọng cho Agent:** Từ iOS 13 trở lên, nếu tài khoản iCloud đã nâng cấp kiến trúc Reminders mới (CloudKit), cổng CalDAV đôi khi chỉ nhận `VEVENT` (Calendar) hoặc cần cầu nối Shortcuts cho `VTODO`. Hệ thống hỗ trợ **Dual-Adapter**:

#### Adapter A: Đồng bộ trực tiếp qua iCloud CalDAV (`icloud.service.ts`)

* Sử dụng giao thức WebDAV/CalDAV thuần qua `fetch` của Cloudflare Worker.

* Khi tạo task mới, gửi request `PUT` tới `https://caldav.icloud.com/{principal}/{calendar_id}/{task.id}.ics` với Header:

  * `Authorization: Basic base64(apple_id:app_specific_password)`

  * `Content-Type: text/calendar; charset=utf-8`

* Nội dung `.ics` chuẩn `VTODO` (kèm `VALARM` để iPhone tự rung chuông):

  ```
  BEGIN:VCALENDAR
  VERSION:2.0
  PRODID:-//CFWorker Telegram Bot//VN
  BEGIN:VTODO
  UID:{{task.id}}
  DTSTAMP:{{now_utc_compact}}
  DUE:{{due_utc_compact}}
  SUMMARY:{{task.title}}
  DESCRIPTION:{{task.description}}
  PRIORITY:{{caldav_priority_number}}
  STATUS:NEEDS-ACTION
  BEGIN:VALARM
  TRIGGER:-PT0M
  ACTION:DISPLAY
  DESCRIPTION:Reminder
  END:VALARM
  END:VTODO
  END:VCALENDAR
  
  ```

#### Adapter B: Đồng bộ qua iOS Shortcuts REST API (Dành cho iOS Reminders CloudKit)

* Worker cung cấp 2 API bảo mật bằng Bearer Token:

  * `GET /api/ios/unsynced`: Trả về danh sách các task có `ios_synced = 0`. Shortcut trên iPhone tự động gọi API này, dùng action "Add New Reminder"原生 của iOS để tạo nhắc nhở, sau đó gửi lại ID đã tạo.

  * `POST /api/ios/webhook`: Khi người dùng tick hoàn thành trên iPhone, Shortcut hoặc Automation gọi về endpoint này để cập nhật `status = 'COMPLETED'` trong D1 và báo lên Telegram.

### Luồng 3: Engine Quét & Đẩy Thông báo (Cron Push Notification Flow)

1. **Cloudflare Cron Trigger** kích hoạt hàm `scheduled(event, env, ctx)` mỗi phút (`* * * * *`).

2. `notifier.service.ts` thực thi câu lệnh SQL trên D1:

   ```
   SELECT t.*, u.timezone 
   FROM tasks t
   JOIN users u ON t.user_id = u.telegram_id
   WHERE t.status = 'PENDING' 
     AND datetime(t.remind_at) <= datetime('now')
   LIMIT 50;
   
   ```

3. Với mỗi task đến hạn:

   * Gửi tin nhắn Telegram tới `user_id` với định dạng nổi bật:

     ```
     🔔 NHẮC VIỆC [KHẨN CẤP]
     📌 Nội dung: Gửi hợp đồng cho khách
     ⏰ Hạn chót: 15:00 - 22/10/2026
     
     ```

   * Đính kèm **Inline Keyboard**:

     * Hàng 1: `[✅ Hoàn thành]`

     * Hàng 2: `[💤 +15 phút]` `[💤 +1 giờ]` `[📅 Ngày mai 9h]`

   * **Xử lý sau khi gửi:**

     * Nếu `nagging_mode = 1` (việc quan trọng): Cập nhật `remind_at = datetime('now', '+10 minutes')` để nếu người dùng chưa bấm `Hoàn thành`, 10 phút sau bot sẽ réo lại.

     * Nếu `nagging_mode = 0` và `remind_at < due_at` (nhắc trước giờ G): Cập nhật `remind_at = due_at`.

     * Nếu đã đúng giờ `due_at` và không bật nagging: Đánh dấu đã gửi thông báo cuối (`last_notified_at = datetime('now')`, đẩy `remind_at` ra xa hoặc chuyển trạng thái chờ xác nhận).

### Luồng 4: Xử lý Phản hồi Nút bấm (Interactive Callback Flow)

Khi người dùng bấm nút trên tin nhắn Telegram, Telegram gửi `callback_query` về Worker:

* **`action:done:{task_id}`**:

  * Nếu task không lặp lại (`recurrence_rule IS NULL`): Cập nhật `status = 'COMPLETED'` trong D1.

  * Nếu task có lặp lại (`recurrence_rule IS NOT NULL`): Tính toán mốc `due_at` và `remind_at` cho chu kỳ tiếp theo $\Delta t$, giữ nguyên `status = 'PENDING'`.

  * Gọi `icloud.service.ts` cập nhật `STATUS:COMPLETED` lên iCloud CalDAV.

  * Sửa lại tin nhắn Telegram (dùng `editMessageText`) thành: *"✅ Đã hoàn thành: Gửi hợp đồng cho khách (lúc 15:02)"*.

* **`action:snooze:{minutes}:{task_id}`**:

  * Cộng thêm số phút tương ứng vào `remind_at`: $t_{\text{new}} = t_{\text{now}} + \Delta t_{\text{snooze}}$.

  * Tăng `snooze_count = snooze_count + 1`.

  * Sửa tin nhắn Telegram: *"💤 Đã hoãn nhắc nhở thêm {minutes} phút."*.

## 6. Thiết kế System Prompt cho AI NLP (`nlp.service.ts`)

AI Agent khi viết code cho `nlp.service.ts` cần sử dụng System Prompt sau để đảm bảo độ chính xác tuyệt đối với tiếng Việt:

```
Bạn là bộ máy phân tích thời gian và công việc tiếng Việt chính xác tuyệt đối.
Thời gian hệ thống hiện tại là: {{CURRENT_ISO_TIME}} ({{DAY_OF_WEEK}}).
Múi giờ mặc định: Asia/Ho_Chi_Minh (+07:00).

Nhiệm vụ: Phân tích câu nói của người dùng và trả về JSON theo đúng schema.
Quy tắc quy đổi thời gian tiếng Việt:
1. "Sáng": mặc định 08:00 nếu không nói rõ giờ. "Trưa": 12:00. "Chiều": +12 tiếng (VD: 3h chiều = 15:00). "Tối": 20:00 (hoặc +12 tiếng nếu từ 6h-11h tối).
2. "Mai" = ngày hiện tại + 1 ngày. "Mốt" / "Ngày kia" = ngày hiện tại + 2 ngày.
3. "Thứ X tuần sau": Tính đúng ngày Thứ X của tuần kế tiếp (Tuần bắt đầu từ Thứ Hai).
4. Nếu người dùng chỉ nói "nhắc sau X phút/tiếng nữa": due_at_iso = CURRENT_ISO_TIME + X phút/tiếng, và remind_before_minutes = 0.
5. Nếu người dùng dùng các từ "gấp", "quan trọng", "nhớ nhắc kỹ", "khẩn": đặt priority = "CRITICAL" và nagging_mode = true.
6. Nếu là việc định kỳ (VD: "mỗi ngày", "ngày 15 hàng tháng", "thứ 2 hàng tuần"): sinh chuỗi chuẩn iCalendar RRULE vào trường recurrence_rrule.

```

## 7. Cấu hình `wrangler.toml` Mẫu

```
name = "telegram-ios-reminder-bot"
main = "src/index.ts"
compatibility_date = "2025-02-01"

# Ràng buộc Cloudflare D1 Database
[[d1_databases]]
binding = "DB"
database_name = "reminder_bot_db"
database_id = "<YOUR_D1_DATABASE_ID>"

# Cấu hình Cron Triggers:
# 1. Chạy mỗi phút để quét và push thông báo nhắc việc
# 2. Chạy lúc 01:00 UTC (08:00 sáng VN) để gửi Daily Briefing
[triggers]
crons = ["* * * * *", "0 1 * * *"]

[vars]
DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh"
LLM_MODEL = "gemini-2.5-flash"

# Các biến nhạy cảm cài đặt qua lệnh `wrangler secret put`:
# - TELEGRAM_BOT_TOKEN
# - TELEGRAM_WEBHOOK_SECRET
# - GEMINI_API_KEY
# - ENCRYPTION_SECRET_KEY (32 bytes hex để mã hóa mật khẩu iCloud)

```

## 8. Quy chuẩn Kỹ thuật & Ràng buộc cho AI Coding Agent (Constraints & Best Practices)

Khi sinh code cho dự án này, Agent bắt buộc tuân thủ các quy tắc sau:

1. **Zero Node.js Native Dependencies:** Không sử dụng các thư viện phụ thuộc vào module `fs`, `net`, `tls` của Node.js cũ. Sử dụng Web Standard APIs (`fetch`, `WebCrypto API`, `Intl.DateTimeFormat`).

2. **Xử lý Bất đồng bộ với `ctx.waitUntil()`:** Telegram yêu cầu Webhook phản hồi HTTP 200 nhanh chóng. Nếu quá trình đồng bộ CalDAV sang Apple iCloud mất $1\text{–}3$ giây, phải đẩy tác vụ đồng bộ iCloud vào `c.executionCtx.waitUntil(syncToICloud(task))` để không làm nghẽn phản hồi của bot.

3. **Idempotency (Tính lũy đẳng):** Tránh việc Telegram gửi lại webhook trùng lặp khi mạng chậm bằng cách kiểm tra `update_id` hoặc xử lý lỗi an toàn.

4. **Bảo mật thông tin iCloud:** Tuyệt đối không lưu `App-Specific Password` của Apple dưới dạng plain text trong D1. Phải mã hóa bằng thuật toán `AES-GCM` thông qua `crypto.subtle` với khóa `ENCRYPTION_SECRET_KEY` lưu trong Cloudflare Secrets.

5. **Quản lý Giới hạn D1 & Workers:** Gom nhóm (batch) các truy vấn cập nhật trạng thái bằng `env.DB.batch([...])` trong Cron Trigger để tối ưu số lượng Read/Write rows trên Cloudflare D1 miễn phí.

## 9. Lộ trình Triển khai (Implementation Phases)

* **Phase 1 — Core Skeleton & Database:** Khởi tạo project Hono + TypeScript, cấu hình `wrangler.toml`, tạo bảng trên D1 và kết nối Telegram Webhook cơ bản (`/start`).

* **Phase 2 — AI NLP & Task CRUD:** Tích hợp Gemini API trích xuất JSON từ tin nhắn tiếng Việt, lưu task vào D1, hiển thị danh sách qua lệnh `/list` và `/today`.

* **Phase 3 — Cron Notification & Inline Actions:** Viết hàm `scheduled()` quét D1 mỗi phút, gửi thông báo Telegram và xử lý các nút bấm `Hoàn thành`, `Snooze`.

* **Phase 4 — iOS Reminders Sync:** Xây dựng `icloud.service.ts` (giao thức CalDAV) và các endpoint dự phòng cho iOS Shortcuts để hoàn thiện đồng bộ hai chiều.