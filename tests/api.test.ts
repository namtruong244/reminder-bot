import { describe, it, expect } from 'vitest';
import app from '../src/index';
import { Env } from '../src/types/env';

function createMockD1(): D1Database {
  const mockStatement = {
    bind: (..._params: unknown[]) => mockStatement,
    first: async <T>() => null as T | null,
    all: async <T>() => ({ results: [] as T[], success: true, meta: { served_by: 'mock', duration: 0, changes: 0, last_row_id: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } }),
    run: async () => ({ results: [], success: true, meta: { served_by: 'mock', duration: 0, changes: 1, last_row_id: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } }),
    raw: async () => [],
  };

  const mockDb = {
    prepare: (_query: string) => mockStatement,
    batch: async <T>() => [] as D1Result<T>[],
    exec: async (_query: string) => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  };

  return mockDb as unknown as D1Database; // Mock D1 database interface for unit testing
}

describe('Hono API Routes', () => {
  const env: Env = {
    DB: createMockD1(),
    TELEGRAM_BOT_TOKEN: 'mock_token',
    TELEGRAM_WEBHOOK_SECRET: 'super_secret',
    IOS_BRIDGE_SECRET: 'ios_bearer_token',
  };

  it('GET / returns 200 OK greeting', async () => {
    const res = await app.fetch(new Request('http://localhost/'), env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Telegram Smart Reminder Bot is running');
  });

  it('GET /health returns status ok JSON', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe('ok');
  });

  it('rejects POST /webhook/telegram if secret token header does not match', async () => {
    const res = await app.fetch(
      new Request('http://localhost/webhook/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret',
        },
        body: JSON.stringify({ update_id: 1 }),
      }),
      env
    );
    expect(res.status).toBe(401);
  });

  it('rejects /api/ios/unsynced without Bearer token', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ios/unsynced'), env);
    expect(res.status).toBe(401);
  });

  it('allows /api/ios/unsynced with valid Bearer token', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ios/unsynced', {
        headers: {
          Authorization: 'Bearer ios_bearer_token',
        },
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; tasks: unknown[] };
    expect(body.count).toBe(0);
    expect(body.tasks).toEqual([]);
  });
});
