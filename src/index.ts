import { Hono, Context, Next } from 'hono';
import { Env } from './types/env';
import { TelegramWebhookHandler } from './bot/webhook';
import { TelegramApi } from './bot/telegram';
import { NotifierService } from './services/notifier.service';
import { TaskService } from './services/task.service';
import { NlpService } from './services/nlp.service';
import {
  calculateNextRecurrence,
  escapeMarkdown,
  formatDisplayDate,
  DEFAULT_TZ,
} from './utils/datetime';

const app = new Hono<{ Bindings: Env }>();

// Middleware for Admin / Diagnostic endpoints
const requireAdminAuth = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const secretKey = c.req.header('X-Admin-Key');
  const expectedKey = c.env.ENCRYPTION_SECRET_KEY || c.env.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedKey || !secretKey || secretKey !== expectedKey) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

// Healthcheck
app.get('/', (c) => c.text('Telegram Smart Reminder Bot is running on Cloudflare Workers! 🚀'));
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ================= DIAGNOSTIC & DEBUG ENDPOINTS =================

/**
 * GET /api/debug
 * Returns current health, secret status (safely masked), and configuration.
 */
app.get('/api/debug', async (c) => {
  let dbHealthy = false;
  let dbError: string | null = null;
  let userCount = 0;
  let taskCount = 0;

  try {
    const uRes = await c.env.DB.prepare('SELECT count(*) as count FROM users;').first<{ count: number }>();
    const tRes = await c.env.DB.prepare('SELECT count(*) as count FROM tasks;').first<{ count: number }>();
    dbHealthy = true;
    userCount = uRes?.count ?? 0;
    taskCount = tRes?.count ?? 0;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const nlp = new NlpService(c.env.GEMINI_API_KEY, c.env.LLM_MODEL);
  const geminiStatus = nlp.getApiKeyStatus();

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gemini: {
      api_key_configured: geminiStatus.configured,
      api_key_preview: geminiStatus.preview || 'NOT_CONFIGURED',
      api_key_length: geminiStatus.length || 0,
      model: nlp.getModel(),
      instruction_if_not_configured: !geminiStatus.configured
        ? 'Chưa cấu hình GEMINI_API_KEY! Chạy lệnh: pnpm exec wrangler secret put GEMINI_API_KEY'
        : 'Sẵn sàng hoạt động ✅',
    },
    telegram: {
      bot_token_configured: !!c.env.TELEGRAM_BOT_TOKEN,
      webhook_secret_configured: !!c.env.TELEGRAM_WEBHOOK_SECRET,
    },
    database: {
      healthy: dbHealthy,
      user_count: userCount,
      task_count: taskCount,
      error: dbError,
    },
    system: {
      default_timezone: c.env.DEFAULT_TIMEZONE || 'Asia/Ho_Chi_Minh',
      encryption_secret_configured: !!c.env.ENCRYPTION_SECRET_KEY,
    },
  });
});

/**
 * GET /api/debug/nlp
 * Tests NLP parsing for a given text prompt with full execution trace.
 * Query param: ?prompt=... or ?text=...
 */
app.get('/api/debug/nlp', async (c) => {
  const prompt = c.req.query('prompt') || c.req.query('text');
  if (!prompt) {
    return c.json(
      {
        error: 'Missing query parameter "prompt" or "text". Example: /api/debug/nlp?prompt=mai+3h+chieu+hop',
      },
      400
    );
  }

  const tz = c.req.query('tz') || c.env.DEFAULT_TIMEZONE || 'Asia/Ho_Chi_Minh';
  const nlp = new NlpService(c.env.GEMINI_API_KEY, c.env.LLM_MODEL);
  const trace = await nlp.parseWithDetailedTrace(prompt, tz);

  return c.json(trace);
});

// Telegram Webhook
app.post('/webhook/telegram', async (c) => {
  const handler = new TelegramWebhookHandler(c.env);
  return handler.handleUpdate(c);
});

// Setup Telegram Webhook utility
app.post('/api/setup-webhook', requireAdminAuth, async (c) => {
  let body: { webhook_url?: string };
  try {
    body = await c.req.json<{ webhook_url?: string }>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { webhook_url } = body;
  if (!webhook_url) {
    return c.json({ error: 'Missing webhook_url' }, 400);
  }

  const telegram = new TelegramApi(c.env.TELEGRAM_BOT_TOKEN);
  const result = await telegram.setWebhook(webhook_url, c.env.TELEGRAM_WEBHOOK_SECRET);
  // Populate the "/" command menu in the Telegram client
  const menuRegistered = await telegram.setMyCommands([
    { command: 'list', description: 'Việc đang chờ' },
    { command: 'today', description: 'Việc hôm nay' },
    { command: 'sync', description: 'Trạng thái đồng bộ iPhone' },
    { command: 'timezone', description: 'Đổi múi giờ' },
    { command: 'help', description: 'Hướng dẫn sử dụng' },
    { command: 'debug', description: 'Kiểm tra bot và thử phân tích câu' },
  ]);
  return c.json({
    success: result.success,
    commands_menu_registered: menuRegistered,
    webhook_url,
    description: result.description,
    error_code: result.error_code,
  });
});

// Diagnostic endpoint to check Telegram status and Database health
app.get('/api/webhook-info', requireAdminAuth, async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ error: 'TELEGRAM_BOT_TOKEN is not configured in Worker secrets.' }, 500);
  }

  let dbHealthy = false;
  let dbError: string | null = null;
  let userCount = 0;
  try {
    const res = await c.env.DB.prepare('SELECT count(*) as count FROM users;').first<{ count: number }>();
    dbHealthy = true;
    userCount = res?.count ?? 0;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
    const telegramInfo = await res.json();
    return c.json({
      telegram: telegramInfo,
      database: {
        healthy: dbHealthy,
        userCount,
        error: dbError,
      },
      secrets_configured: {
        TELEGRAM_BOT_TOKEN: !!c.env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_WEBHOOK_SECRET: !!c.env.TELEGRAM_WEBHOOK_SECRET,
        GEMINI_API_KEY: !!c.env.GEMINI_API_KEY,
        ENCRYPTION_SECRET_KEY: !!c.env.ENCRYPTION_SECRET_KEY,
      },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Test sending a message from Worker to verify bot token and reachability
app.post('/api/test-message', requireAdminAuth, async (c) => {
  let body: { chat_id?: number | string; text?: string };
  try {
    body = await c.req.json<{ chat_id?: number | string; text?: string }>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { chat_id, text } = body;
  if (!chat_id) {
    return c.json({ error: 'Missing chat_id in JSON body' }, 400);
  }
  const telegram = new TelegramApi(c.env.TELEGRAM_BOT_TOKEN);
  const res = await telegram.sendMessage(chat_id, text || '🔔 Test message from Worker!');
  return c.json({ success: !!res, result: res });
});

// Quick endpoint to apply D1 schema migration directly
app.post('/api/migrate', requireAdminAuth, async (c) => {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
        icloud_apple_id TEXT,
        icloud_app_password_enc TEXT,
        icloud_calendar_url TEXT,
        sync_token TEXT,
        morning_brief_time TEXT DEFAULT '08:00',
        created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        due_at TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        priority TEXT DEFAULT 'MEDIUM' CHECK(priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
        recurrence_rule TEXT,
        nagging_mode INTEGER DEFAULT 0,
        snooze_count INTEGER DEFAULT 0,
        caldav_etag TEXT,
        ios_synced INTEGER DEFAULT 0,
        last_notified_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(telegram_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_due_scan ON tasks(status, remind_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_ios_synced ON tasks(ios_synced, status);

    CREATE TABLE IF NOT EXISTS processed_updates (
        update_id INTEGER PRIMARY KEY,
        received_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_processed_updates_received ON processed_updates(received_at);
  `;

  try {
    await c.env.DB.exec(schema);
    return c.json({ success: true, message: 'D1 database schema applied successfully!' });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ================= ADAPTER B: iOS Shortcuts REST Bridge =================

/**
 * Middleware for iOS Bridge authentication.
 * Accepts (headers only, so the secret never lands in URLs/logs):
 *  - Header: Authorization: Bearer <secret>
 *  - Header: X-Bridge-Token: <secret> / X-API-Key: <secret> / Token: <secret>
 * The secret is IOS_BRIDGE_SECRET only; ENCRYPTION_SECRET_KEY must never be reused here.
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
};

const authIosBridge = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const expectedSecret = c.env.IOS_BRIDGE_SECRET;

  if (!expectedSecret) {
    return c.json({ error: 'IOS_BRIDGE_SECRET is not configured on server' }, 500);
  }

  const authHeader = c.req.header('Authorization');
  const bearer = authHeader && /^Bearer\s+/i.test(authHeader)
    ? authHeader.replace(/^Bearer\s+/i, '').trim()
    : undefined;

  const candidates = [
    bearer,
    c.req.header('X-Bridge-Token'),
    c.req.header('X-API-Key'),
    c.req.header('Token'),
  ]
    .filter((v): v is string => !!v)
    .map((v) => v.trim());

  if (candidates.length === 0) {
    return c.json(
      {
        error:
          'Missing authorization. Provide header "Authorization: Bearer <token>" or "X-Bridge-Token: <token>"',
      },
      401
    );
  }

  if (!candidates.some((t) => timingSafeEqual(t, expectedSecret))) {
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }

  await next();
};

/**
 * Safely parses any body format (JSON, Form Data, or Text) sent from iOS Shortcuts or HTTP clients.
 */
async function parseAnyRequestBody(c: Context<{ Bindings: Env }>): Promise<unknown> {
  const contentType = (c.req.header('Content-Type') || '').toLowerCase();

  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    try {
      return await c.req.parseBody();
    } catch {
      return null;
    }
  }

  // Read the body exactly once as text: a failed c.req.json() would poison the cached body.
  try {
    const rawText = (await c.req.text()).trim();
    if (!rawText) return null;
    if (rawText.startsWith('{') || rawText.startsWith('[')) {
      try {
        return JSON.parse(rawText);
      } catch {
        return rawText;
      }
    }
    return rawText;
  } catch {
    return null;
  }
}

/**
 * Robustly extracts task IDs from request body, query params, or array payloads.
 * Handles:
 *  - { "task_id": "abc" }
 *  - { "task_ids": ["abc", "def"] }
 *  - { "id": "abc" }
 *  - { "ids": ["abc", "def"] }
 *  - { "taskId": "abc" }
 *  - ["abc", "def"]
 *  - [{ "id": "abc" }, { "task_id": "def" }]
 *  - Query params (?task_id=abc, ?id=abc, ?task_ids=abc,def)
 *  - Raw string / newline-delimited text
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractTaskIds(
  body: unknown,
  queryParams: Record<string, string | undefined>
): string[] {
  const ids = new Set<string>();

  const addValue = (val: unknown) => {
    if (val === undefined || val === null) return;
    if (typeof val === 'string') {
      val
        .split(/[\r\n,]+/)
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .forEach((id) => ids.add(id));
    } else if (typeof val === 'number') {
      ids.add(String(val));
    } else if (Array.isArray(val)) {
      for (const item of val) {
        addValue(item);
      }
    } else if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const keys = ['task_id', 'taskId', 'task_ids', 'taskIds', 'id', 'ids', 'task'];
      let matchedKnownKey = false;
      for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null) {
          addValue(obj[k]);
          matchedKnownKey = true;
        }
      }
      if (!matchedKnownKey) {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string' && UUID_RE.test(v.trim())) {
            addValue(v);
          }
        }
      }
    }
  };

  // 1. From query params
  for (const qKey of ['task_id', 'taskId', 'id', 'task_ids', 'taskIds', 'ids']) {
    addValue(queryParams[qKey]);
  }

  // 2. From body
  addValue(body);

  return Array.from(ids);
}

/**
 * GET /api/ios/unsynced
 * Returns tasks pending to be added to iOS Reminders via iOS Shortcut.
 * Supports optional ?user_id=<telegram_id> query parameter to isolate multi-user data.
 */
app.get('/api/ios/unsynced', authIosBridge, async (c) => {
  const userIdQuery = c.req.query('user_id');
  const parsedUserId = userIdQuery ? parseInt(userIdQuery, 10) : undefined;
  if (userIdQuery && Number.isNaN(parsedUserId)) {
    return c.json({ error: 'Invalid user_id query parameter' }, 400);
  }

  const limitQuery = c.req.query('limit');
  const parsedLimit = limitQuery ? parseInt(limitQuery, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 50;

  const taskService = new TaskService(c.env.DB);
  const unsynced = await taskService.getUnsyncedIosTasks(limit, parsedUserId);
  return c.json({
    count: unsynced.length,
    tasks: unsynced.map((t) => ({
      id: t.id,
      user_id: t.user_id,
      title: t.title,
      description: t.description,
      due_at: t.due_at,
      remind_at: t.remind_at,
      priority: t.priority,
      recurrence_rule: t.recurrence_rule,
      ios_synced: t.ios_synced ?? 0,
    })),
  });
});

/**
 * Marks task(s) as synced (ios_synced = 1) in Cloudflare D1.
 * Supports POST /api/ios/synced and POST /api/ios/sync (state-changing, so no GET)
 * Accepts single task_id, array of task_ids, or query parameter.
 */
const handleMarkSynced = async (c: Context<{ Bindings: Env }>) => {
  const body = await parseAnyRequestBody(c);

  const queryParams = {
    task_id: c.req.query('task_id'),
    taskId: c.req.query('taskId'),
    id: c.req.query('id'),
    task_ids: c.req.query('task_ids'),
    taskIds: c.req.query('taskIds'),
    ids: c.req.query('ids'),
  };

  const taskIds = extractTaskIds(body, queryParams);

  if (taskIds.length === 0) {
    return c.json(
      {
        error:
          'No task ID provided. Send JSON: { "task_id": "..." } or { "task_ids": [...] }, form-data, or query ?task_id=...',
        received_body: body,
      },
      400
    );
  }

  const taskService = new TaskService(c.env.DB);
  const updatedIds = await taskService.batchMarkTasksIosSynced(taskIds, 1);

  if (updatedIds.length === 0) {
    return c.json({ error: 'No matching tasks found', requested_ids: taskIds }, 404);
  }

  return c.json({
    success: true,
    synced_count: updatedIds.length,
    updated_ids: updatedIds,
  });
};

app.post('/api/ios/synced', authIosBridge, handleMarkSynced);
app.post('/api/ios/sync', authIosBridge, handleMarkSynced);

/**
 * GET /api/ios/closed
 * Returns tasks completed/cancelled on the Telegram side that still have an open reminder on
 * the iPhone (ios_synced = 1). The Shortcut should complete/delete them, then POST /api/ios/closed.
 */
app.get('/api/ios/closed', authIosBridge, async (c) => {
  const userIdQuery = c.req.query('user_id');
  const parsedUserId = userIdQuery ? parseInt(userIdQuery, 10) : undefined;
  if (userIdQuery && Number.isNaN(parsedUserId)) {
    return c.json({ error: 'Invalid user_id query parameter' }, 400);
  }

  const taskService = new TaskService(c.env.DB);
  const closed = await taskService.getIosClosedTasks(100, parsedUserId);
  return c.json({
    count: closed.length,
    tasks: closed.map((t) => ({
      id: t.id,
      user_id: t.user_id,
      title: t.title,
      status: t.status,
    })),
  });
});

/** POST /api/ios/closed — confirms the iPhone reminders were closed (ios_synced = 2). */
app.post('/api/ios/closed', authIosBridge, async (c) => {
  const taskIds = extractTaskIds(await parseAnyRequestBody(c), {
    task_id: c.req.query('task_id'),
    id: c.req.query('id'),
    task_ids: c.req.query('task_ids'),
    ids: c.req.query('ids'),
  });
  if (taskIds.length === 0) {
    return c.json({ error: 'No task ID provided' }, 400);
  }
  const taskService = new TaskService(c.env.DB);
  const updatedIds = await taskService.batchMarkTasksIosSynced(taskIds, 2);
  return c.json({ success: true, synced_count: updatedIds.length, updated_ids: updatedIds });
});

/**
 * POST /api/ios/webhook
 * Receives completion events from iOS Shortcut when user marks a reminder done on iPhone.
 */
app.post('/api/ios/webhook', authIosBridge, async (c) => {
  const parsed = await parseAnyRequestBody(c);
  const body: any = parsed && typeof parsed === 'object' ? parsed : null;

  const taskId =
    body?.task_id ||
    body?.taskId ||
    body?.id ||
    c.req.query('task_id') ||
    c.req.query('id');

  if (!taskId) {
    return c.json({ error: 'Missing task_id. Send { "task_id": "..." }' }, 400);
  }

  const rawAction = body?.action || c.req.query('action');
  if (!rawAction) {
    return c.json({ error: 'Missing action. Expected COMPLETED or CANCELLED' }, 400);
  }
  const action = String(rawAction).toUpperCase();

  if (action !== 'COMPLETED' && action !== 'CANCELLED') {
    return c.json({ error: 'Invalid action. Expected COMPLETED or CANCELLED' }, 400);
  }

  const taskService = new TaskService(c.env.DB);
  const task = await taskService.getTaskById(taskId);

  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  // Idempotency: repeated/late iOS events must not re-complete, re-cancel or re-advance tasks.
  if (task.status !== 'PENDING') {
    return c.json({ success: true, task_id: taskId, action, ignored: true, status: task.status });
  }

  const telegram = new TelegramApi(c.env.TELEGRAM_BOT_TOKEN);
  const safeTitle = escapeMarkdown(task.title);

  if (action === 'COMPLETED') {
    if (task.recurrence_rule) {
      const user = await taskService.getUser(task.user_id);
      const tz = user?.timezone || DEFAULT_TZ;
      const next = calculateNextRecurrence(task.due_at, task.remind_at, task.recurrence_rule, tz);
      await taskService.completeTask(taskId, next);

      await telegram.sendMessage(
        task.user_id,
        `📱✅ *Đã hoàn thành chu kỳ hiện tại từ iPhone Reminders:*\n📌 ${safeTitle}\n⏰ Lần nhắc tiếp theo: *${formatDisplayDate(
          next.remindAt,
          tz
        )}*`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await taskService.completeTask(taskId);

      await telegram.sendMessage(
        task.user_id,
        `📱✅ *Đã đánh dấu hoàn thành từ iPhone Reminders:*\n📌 ${safeTitle}`,
        { parse_mode: 'Markdown' }
      );
    }
  } else if (action === 'CANCELLED') {
    await taskService.cancelTask(taskId);

    await telegram.sendMessage(
      task.user_id,
      `📱🗑 *Đã hủy nhắc việc từ iPhone Reminders:*\n📌 ~${safeTitle}~`,
      { parse_mode: 'Markdown' }
    );
  }

  return c.json({ success: true, task_id: taskId, action });
});

// ================= CLOUDFLARE WORKER EXPORT =================

export default {
  fetch: app.fetch,

  /**
   * Cloudflare Cron Trigger Handler
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const notifier = new NotifierService(env);

    // If cron trigger is at 01:00 UTC (08:00 VN)
    if (event.cron === '0 1 * * *') {
      ctx.waitUntil(notifier.processMorningBriefing());
      ctx.waitUntil(new TaskService(env.DB).purgeProcessedUpdates());
      return;
    }

    // Default: minute-by-minute scan
    ctx.waitUntil(notifier.processDueTasks());
  },
};
