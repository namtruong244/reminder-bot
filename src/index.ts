import { Hono, Context, Next } from 'hono';
import { Env } from './types/env';
import { TelegramWebhookHandler } from './bot/webhook';
import { TelegramApi } from './bot/telegram';
import { NotifierService } from './services/notifier.service';
import { TaskService } from './services/task.service';

const app = new Hono<{ Bindings: Env }>();

// Healthcheck
app.get('/', (c) => c.text('Telegram Smart Reminder Bot is running on Cloudflare Workers! 🚀'));
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Telegram Webhook
app.post('/webhook/telegram', async (c) => {
  const handler = new TelegramWebhookHandler(c.env);
  return handler.handleUpdate(c);
});

// Setup Telegram Webhook utility
app.post('/api/setup-webhook', async (c) => {
  const secretKey = c.req.header('X-Admin-Key');
  if (c.env.ENCRYPTION_SECRET_KEY && secretKey !== c.env.ENCRYPTION_SECRET_KEY) {
    return c.text('Unauthorized', 401);
  }

  const { webhook_url } = await c.req.json<{ webhook_url?: string }>();
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
app.get('/api/webhook-info', async (c) => {
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
app.post('/api/test-message', async (c) => {
  const { chat_id, text } = await c.req.json<{ chat_id?: number | string; text?: string }>();
  if (!chat_id) {
    return c.json({ error: 'Missing chat_id in JSON body' }, 400);
  }
  const telegram = new TelegramApi(c.env.TELEGRAM_BOT_TOKEN);
  const res = await telegram.sendMessage(chat_id, text || '🔔 Test message from Worker!');
  return c.json({ success: !!res, result: res });
});

// Quick endpoint to apply D1 schema migration directly
app.post('/api/migrate', async (c) => {
  const secretKey = c.req.header('X-Admin-Key');
  if (c.env.ENCRYPTION_SECRET_KEY && secretKey !== c.env.ENCRYPTION_SECRET_KEY) {
    return c.text('Unauthorized', 401);
  }

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

  if (expectedSecret) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }
    const token = authHeader.replace(/^Bearer\s+/, '');
    if (token !== expectedSecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
};

/**
 * GET /api/ios/unsynced
 * Returns tasks pending to be added to iOS Reminders via iOS Shortcut.
 */
app.get('/api/ios/unsynced', authIosBridge, async (c) => {
  const taskService = new TaskService(c.env.DB);
  const unsynced = await taskService.getUnsyncedIosTasks(50);
  return c.json({
    count: unsynced.length,
    tasks: unsynced.map((t) => ({
      id: t.id,
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
  const { task_ids } = await c.req.json<{ task_ids?: string[] }>();
  if (!task_ids || !Array.isArray(task_ids)) {
    return c.json({ error: 'Missing task_ids array' }, 400);
  }

  const taskService = new TaskService(c.env.DB);
  for (const id of task_ids) {
    await taskService.markTaskIosSynced(id, 1);
  }

  return c.json({ success: true, synced_count: task_ids.length });
});

/**
 * POST /api/ios/webhook
 * Receives completion events from iOS Shortcut when user marks a reminder done on iPhone.
 */
app.post('/api/ios/webhook', authIosBridge, async (c) => {
  const body = await c.req.json<{ task_id: string; action: 'COMPLETED' | 'CANCELLED' }>();
  if (!body.task_id) {
    return c.json({ error: 'Missing task_id' }, 400);
  }

  const taskService = new TaskService(c.env.DB);
  const task = await taskService.getTaskById(body.task_id);

  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  if (body.action === 'COMPLETED') {
    await taskService.completeTask(body.task_id);

    // Notify user on Telegram
    const telegram = new TelegramApi(c.env.TELEGRAM_BOT_TOKEN);
    await telegram.sendMessage(
      task.user_id,
      `📱✅ *Đã đánh dấu hoàn thành từ iPhone Reminders:*\n📌 ${task.title}`,
      { parse_mode: 'Markdown' }
    );
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
