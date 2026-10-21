import { TaskRecord, UserRecord, TaskStatus, TaskPriority } from '../types/task';
import { DEFAULT_TZ } from '../utils/datetime';

export class TaskService {
  constructor(private db: D1Database) {}

  // ================= USER OPERATIONS =================

  async getUser(telegramId: number): Promise<UserRecord | null> {
    const query = `SELECT * FROM users WHERE telegram_id = ? LIMIT 1;`;
    const result = await this.db.prepare(query).bind(telegramId).first<UserRecord>();
    return result || null;
  }

  async upsertUser(user: {
    telegram_id: number;
    username?: string | null;
    timezone?: string;
  }): Promise<UserRecord> {
    const tz = user.timezone || DEFAULT_TZ;
    const existing = await this.getUser(user.telegram_id);

    if (!existing) {
      await this.db
        .prepare(`INSERT OR IGNORE INTO users (telegram_id, username, timezone) VALUES (?, ?, ?);`)
        .bind(user.telegram_id, user.username || null, tz)
        .run();
    } else if (user.username && user.username !== existing.username) {
      await this.db
        .prepare(`UPDATE users SET username = ? WHERE telegram_id = ?;`)
        .bind(user.username, user.telegram_id)
        .run();
    }

    const fetched = await this.getUser(user.telegram_id);
    if (!fetched) {
      return {
        telegram_id: user.telegram_id,
        username: user.username,
        timezone: tz,
      };
    }
    return fetched;
  }

  async updateUserICloud(
    telegramId: number,
    appleId: string,
    encryptedPassword: string,
    calendarUrl: string
  ): Promise<void> {
    const query = `
      UPDATE users
      SET icloud_apple_id = ?,
          icloud_app_password_enc = ?,
          icloud_calendar_url = ?
      WHERE telegram_id = ?;
    `;
    await this.db.prepare(query).bind(appleId, encryptedPassword, calendarUrl, telegramId).run();
  }

  async updateUserTimezone(telegramId: number, timezone: string): Promise<void> {
    const query = `UPDATE users SET timezone = ? WHERE telegram_id = ?;`;
    await this.db.prepare(query).bind(timezone, telegramId).run();
  }

  // ================= TASK OPERATIONS =================

  async createTask(task: {
    id: string;
    user_id: number;
    title: string;
    description?: string | null;
    due_at: string;
    remind_at: string;
    priority?: TaskPriority;
    status?: TaskStatus;
    recurrence_rule?: string | null;
    nagging_mode?: number;
    snooze_count?: number;
    ios_synced?: number;
  }): Promise<TaskRecord> {
    const priority = task.priority || 'MEDIUM';
    const status = task.status || 'PENDING';
    const naggingMode = task.nagging_mode ? 1 : 0;
    const snoozeCount = task.snooze_count || 0;
    const iosSynced = task.ios_synced ? 1 : 0;

    const query = `
      INSERT INTO tasks (
        id, user_id, title, description, due_at, remind_at,
        priority, status, recurrence_rule, nagging_mode, snooze_count, ios_synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;

    await this.db
      .prepare(query)
      .bind(
        task.id,
        task.user_id,
        task.title,
        task.description || null,
        task.due_at,
        task.remind_at,
        priority,
        status,
        task.recurrence_rule || null,
        naggingMode,
        snoozeCount,
        iosSynced
      )
      .run();

    const fetched = await this.getTaskById(task.id);
    if (!fetched) {
      return {
        id: task.id,
        user_id: task.user_id,
        title: task.title,
        description: task.description,
        due_at: task.due_at,
        remind_at: task.remind_at,
        priority,
        status,
        recurrence_rule: task.recurrence_rule,
        nagging_mode: naggingMode,
        snooze_count: snoozeCount,
        ios_synced: iosSynced,
      };
    }
    return fetched;
  }
  async getTaskById(taskId: string): Promise<TaskRecord | null> {
    const query = `SELECT * FROM tasks WHERE id = ? LIMIT 1;`;
    const result = await this.db.prepare(query).bind(taskId).first<TaskRecord>();
    return result || null;
  }

  /**
   * Scans tasks ready to be notified.
   * Query uses the idx_tasks_due_scan index.
   */
  async getPendingTasksDue(limit = 50): Promise<Array<TaskRecord & { timezone: string }>> {
    const query = `
      SELECT t.*, COALESCE(u.timezone, 'Asia/Ho_Chi_Minh') as timezone
      FROM tasks t
      JOIN users u ON t.user_id = u.telegram_id
      WHERE t.status = 'PENDING'
        AND datetime(t.remind_at) <= datetime('now')
      LIMIT ?;
    `;
    const { results } = await this.db.prepare(query).bind(limit).all<TaskRecord & { timezone: string }>();
    return results || [];
  }

  /**
   * Fetches tasks for a specific user, optionally filtered by status.
   */
  async getTasksByUser(userId: number, status?: TaskStatus, limit = 20): Promise<TaskRecord[]> {
    let query = `
      SELECT * FROM tasks
      WHERE user_id = ?
    `;
    const params: (string | number)[] = [userId];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    query += ` ORDER BY due_at ASC LIMIT ?;`;
    params.push(limit);

    const { results } = await this.db.prepare(query).bind(...params).all<TaskRecord>();
    return results || [];
  }

  /**
   * Fetches today's tasks for a user based on user's timezone.
   */
  async getTodayTasks(userId: number, timezone = DEFAULT_TZ): Promise<TaskRecord[]> {
    // Get start and end of today in user's timezone converted to UTC ISO
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    const lookup: Record<string, string> = {};
    for (const p of parts) {
      lookup[p.type] = p.value;
    }
    const todayStr = `${lookup.year}-${lookup.month}-${lookup.day}`;

    // Tasks due or pending where local date matches today
    const query = `
      SELECT * FROM tasks
      WHERE user_id = ?
        AND status = 'PENDING'
        AND date(due_at, '+7 hours') = ?
      ORDER BY due_at ASC;
    `;
    const { results } = await this.db.prepare(query).bind(userId, todayStr).all<TaskRecord>();
    return results || [];
  }

  /**
   * Marks a task as COMPLETED or schedules its next recurrence.
   */
  async completeTask(
    taskId: string,
    nextRecurrence?: { dueAt: string; remindAt: string } | null
  ): Promise<TaskRecord | null> {
    if (nextRecurrence) {
      const query = `
        UPDATE tasks
        SET due_at = ?,
            remind_at = ?,
            status = 'PENDING',
            snooze_count = 0,
            updated_at = datetime('now')
        WHERE id = ?;
      `;
      await this.db
        .prepare(query)
        .bind(nextRecurrence.dueAt, nextRecurrence.remindAt, taskId)
        .run();
      return this.getTaskById(taskId);
    }

    const query = `
      UPDATE tasks
      SET status = 'COMPLETED',
          updated_at = datetime('now')
      WHERE id = ?;
    `;
    await this.db.prepare(query).bind(taskId).run();
    return this.getTaskById(taskId);
  }

  /**
   * Snoozes a task by updating its remind_at and incrementing snooze_count.
   */
  async snoozeTask(taskId: string, newRemindAt: string): Promise<TaskRecord | null> {
    const query = `
      UPDATE tasks
      SET remind_at = ?,
          snooze_count = snooze_count + 1,
          updated_at = datetime('now')
      WHERE id = ?;
    `;
    await this.db.prepare(query).bind(newRemindAt, taskId).run();
    return this.getTaskById(taskId);
  }

  /**
   * Cancels a task.
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const query = `
      UPDATE tasks
      SET status = 'CANCELLED',
          updated_at = datetime('now')
      WHERE id = ?;
    `;
    const result = await this.db.prepare(query).bind(taskId).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Batches task remind_at updates for Cron optimization.
   */
  async batchUpdateRemindAt(
    updates: Array<{ id: string; remind_at: string; last_notified_at?: string }>
  ): Promise<void> {
    if (updates.length === 0) return;

    const statements = updates.map((u) => {
      if (u.last_notified_at) {
        return this.db
          .prepare(
            `UPDATE tasks SET remind_at = ?, last_notified_at = ?, updated_at = datetime('now') WHERE id = ?;`
          )
          .bind(u.remind_at, u.last_notified_at, u.id);
      }
      return this.db
        .prepare(`UPDATE tasks SET remind_at = ?, updated_at = datetime('now') WHERE id = ?;`)
        .bind(u.remind_at, u.id);
    });

    await this.db.batch(statements);
  }

  /**
   * Gets unsynced tasks for iOS Shortcuts Bridge (Adapter B).
   */
  async getUnsyncedIosTasks(limit = 20): Promise<TaskRecord[]> {
    const query = `
      SELECT * FROM tasks
      WHERE ios_synced = 0
        AND status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT ?;
    `;
    const { results } = await this.db.prepare(query).bind(limit).all<TaskRecord>();
    return results || [];
  }

  /**
   * Marks a task as synced with iOS.
   */
  async markTaskIosSynced(taskId: string, synced = 1): Promise<void> {
    const query = `UPDATE tasks SET ios_synced = ?, updated_at = datetime('now') WHERE id = ?;`;
    await this.db.prepare(query).bind(synced, taskId).run();
  }

  /**
   * Updates CalDAV ETag after syncing with iCloud.
   */
  async updateTaskCaldavEtag(taskId: string, etag: string): Promise<void> {
    const query = `
      UPDATE tasks
      SET caldav_etag = ?,
          ios_synced = 1,
          updated_at = datetime('now')
      WHERE id = ?;
    `;
    await this.db.prepare(query).bind(etag, taskId).run();
  }
}
