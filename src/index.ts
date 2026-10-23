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
  return c.json({
    success: result.success,
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
  `;

  try {
    await c.env.DB.exec(schema);
    return c.json({ success: true, message: 'D1 database schema applied successfully!' });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ================= ADAPTER B: iOS Shortcuts REST Bridge =================

// Middleware for iOS Bridge authentication
const authIosBridge = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const authHeader = c.req.header('Authorization');
  const expectedSecret = c.env.IOS_BRIDGE_SECRET || c.env.ENCRYPTION_SECRET_KEY;

  if (!expectedSecret) {
    return c.json({ error: 'iOS Bridge secret is not configured on server' }, 500);
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.replace(/^Bearer\s+/, '');
  if (token !== expectedSecret) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
};

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

  const taskService = new TaskService(c.env.DB);
  const unsynced = await taskService.getUnsyncedIosTasks(50, parsedUserId);
  return c.json({
    count: unsynced.length,
    tasks: unsynced.map((t) => ({
      id: t.id,
      user_id: t.user_id,
      title: t.title,
      description: t.description,
      due_at: t.due_at,
      priority: t.priority,
    })),
  });
});

/**
 * POST /api/ios/synced
 * Marks tasks as synced once created in iOS Reminders.
 */
app.post('/api/ios/synced', authIosBridge, async (c) => {
  let body: { task_ids?: string[] };
  try {
    body = await c.req.json<{ task_ids?: string[] }>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { task_ids } = body;
  if (!task_ids || !Array.isArray(task_ids)) {
    return c.json({ error: 'Missing task_ids array' }, 400);
  }

  const taskService = new TaskService(c.env.DB);
  await taskService.batchMarkTasksIosSynced(task_ids, 1);

  return c.json({ success: true, synced_count: task_ids.length });
});

/**
 * POST /api/ios/webhook
 * Receives completion events from iOS Shortcut when user marks a reminder done on iPhone.
 */
app.post('/api/ios/webhook', authIosBridge, async (c) => {
  let body: { task_id?: string; action?: 'COMPLETED' | 'CANCELLED' };
  try {
    body = await c.req.json<{ task_id?: string; action?: 'COMPLETED' | 'CANCELLED' }>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.task_id) {
    return c.json({ error: 'Missing task_id' }, 400);
  }

  if (body.action !== 'COMPLETED' && body.action !== 'CANCELLED') {
    return c.json({ error: 'Invalid action. Expected COMPLETED or CANCELLED' }, 400);
  }

  const taskService = new TaskService(c.env.DB);
  const task = await taskService.getTaskById(body.task_id);

  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const telegram = new TelegramApi(c.env.TELEGRAM_BOT_TOKEN);
  const safeTitle = escapeMarkdown(task.title);

  if (body.action === 'COMPLETED') {
    if (task.recurrence_rule) {
      const user = await taskService.getUser(task.user_id);
      const tz = user?.timezone || DEFAULT_TZ;
      const next = calculateNextRecurrence(task.due_at, task.remind_at, task.recurrence_rule, tz);
      await taskService.completeTask(body.task_id, next);

      await telegram.sendMessage(
        task.user_id,
        `📱✅ *Đã hoàn thành chu kỳ hiện tại từ iPhone Reminders:*\n📌 ${safeTitle}\n⏰ Lần nhắc tiếp theo: *${formatDisplayDate(
          next.remindAt,
          tz
        )}*`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await taskService.completeTask(body.task_id);

      await telegram.sendMessage(
        task.user_id,
        `📱✅ *Đã đánh dấu hoàn thành từ iPhone Reminders:*\n📌 ${safeTitle}`,
        { parse_mode: 'Markdown' }
      );
    }
  } else if (body.action === 'CANCELLED') {
    await taskService.cancelTask(body.task_id);
  }

  return c.json({ success: true, task_id: body.task_id, action: body.action });
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
      return;
    }

    // Default: minute-by-minute scan
    ctx.waitUntil(notifier.processDueTasks());
  },
};
