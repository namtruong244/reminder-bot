import { describe, it, expect } from 'vitest';
import app from '../src/index';
import { Env } from '../src/types/env';

function createMockD1(): D1Database {
  const mockStatement = {
    bind: (..._params: unknown[]) => mockStatement,
    first: async <T>() => null as T | null,
    all: async <T>() => ({
      results: [] as T[],
      success: true,
      meta: {
        served_by: 'mock',
        duration: 0,
        changes: 0,
        last_row_id: 0,
        changed_db: false,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
      },
    }),
    run: async () => ({
      results: [],
      success: true,
      meta: {
        served_by: 'mock',
        duration: 0,
        changes: 1,
        last_row_id: 0,
        changed_db: false,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
      },
    }),
    raw: async () => [],
  };

  const mockDb = {
    prepare: (_query: string) => mockStatement,
    // Every statement in a batch reports one changed row, like a successful UPDATE
    batch: async <T>(statements: unknown[]) =>
      statements.map(() => ({ results: [], success: true, meta: { changes: 1 } })) as unknown as D1Result<T>[],
    exec: async (_query: string) => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  };

  return mockDb as unknown as D1Database;
}

describe('Hono API Routes', () => {
  const env: Env = {
    DB: createMockD1(),
    TELEGRAM_BOT_TOKEN: 'mock_token',
    TELEGRAM_WEBHOOK_SECRET: 'super_secret',
    ENCRYPTION_SECRET_KEY: 'admin_encryption_secret',
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

  it('rejects unauthenticated access to /api/test-message and /api/webhook-info', async () => {
    const testMsgRes = await app.fetch(
      new Request('http://localhost/api/test-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: 123, text: 'hello' }),
      }),
      env
    );
    expect(testMsgRes.status).toBe(401);

    const infoRes = await app.fetch(new Request('http://localhost/api/webhook-info'), env);
    expect(infoRes.status).toBe(401);
  });

  it('GET /api/debug returns environment and secrets status safely', async () => {
    const res = await app.fetch(new Request('http://localhost/api/debug'), env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      status: string;
      gemini: { api_key_configured: boolean; model: string };
      database: { healthy: boolean };
    };
    expect(data.status).toBe('ok');
    expect(data.gemini.api_key_configured).toBe(false);
    expect(data.gemini.model).toBe('gemini-3.5-flash');
    expect(data.database.healthy).toBe(true);
  });

  it('GET /api/debug/nlp returns full trace or error on missing prompt', async () => {
    const errRes = await app.fetch(new Request('http://localhost/api/debug/nlp'), env);
    expect(errRes.status).toBe(400);

    const validRes = await app.fetch(
      new Request('http://localhost/api/debug/nlp?prompt=mai+9h+hop'),
      env
    );
    expect(validRes.status).toBe(200);
    const trace = (await validRes.json()) as {
      text: string;
      source: string;
      result: { intent: string; title: string };
    };
    expect(trace.text).toBe('mai 9h hop');
    expect(trace.source).toBe('REGEX_NO_API_KEY');
    expect(trace.result.intent).toBe('CREATE_TASK');
    expect(trace.result.title).toBe('hop');
  });

  it('rejects /api/ios/unsynced without Bearer token', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ios/unsynced'), env);
    expect(res.status).toBe(401);
  });

  it('rejects /api/ios/unsynced with 500 when no server secret is configured', async () => {
    const unconfiguredEnv: Env = {
      DB: createMockD1(),
      TELEGRAM_BOT_TOKEN: 'mock_token',
    };
    const res = await app.fetch(
      new Request('http://localhost/api/ios/unsynced', {
        headers: { Authorization: 'Bearer anything' },
      }),
      unconfiguredEnv
    );
    expect(res.status).toBe(500);
  });

  it('allows /api/ios/unsynced with valid Bearer token and optional user_id filter', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ios/unsynced?user_id=123456', {
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

  it('returns 400 on empty body without task_id in /api/ios/synced', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ios/synced', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ios_bearer_token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No task ID provided');
  });

  it('successfully marks task synced when receiving { task_id: "..." }', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ios/synced', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ios_bearer_token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ task_id: 'task-single-uuid-123' }),
      }),
      env
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; synced_count: number; updated_ids: string[] };
    expect(data.success).toBe(true);
    expect(data.synced_count).toBe(1);
    expect(data.updated_ids).toContain('task-single-uuid-123');
  });

  it('successfully marks task synced when receiving { id: "..." }', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ios/synced', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ios_bearer_token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'task-id-field-456' }),
      }),
      env
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; synced_count: number; updated_ids: string[] };
    expect(data.success).toBe(true);
    expect(data.synced_count).toBe(1);
    expect(data.updated_ids).toContain('task-id-field-456');
  });

  it('successfully marks task synced when receiving JSON array of IDs ["id1", "id2"]', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ios/synced', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ios_bearer_token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['task-arr-1', 'task-arr-2']),
      }),
      env
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; synced_count: number; updated_ids: string[] };
    expect(data.success).toBe(true);
    expect(data.synced_count).toBe(2);
    expect(data.updated_ids).toEqual(['task-arr-1', 'task-arr-2']);
  });

  it('successfully marks task synced with query parameter ?task_id=...', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ios/synced?task_id=query-task-789', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ios_bearer_token',
        },
      }),
      env
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; synced_count: number; updated_ids: string[] };
    expect(data.success).toBe(true);
    expect(data.synced_count).toBe(1);
    expect(data.updated_ids).toContain('query-task-789');
  });

  it('authenticates via X-Bridge-Token header but rejects the secret in a query string', async () => {
    // Via X-Bridge-Token
    const resHeader = await app.fetch(
      new Request('http://localhost/api/ios/synced', {
        method: 'POST',
        headers: {
          'X-Bridge-Token': 'ios_bearer_token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ task_id: 'task-via-header' }),
      }),
      env
    );
    expect(resHeader.status).toBe(200);

    // Secrets in URLs end up in logs, so ?token=... must not authenticate
    const resQuery = await app.fetch(
      new Request('http://localhost/api/ios/unsynced?token=ios_bearer_token', { method: 'GET' }),
      env
    );
    expect(resQuery.status).toBe(401);

    // State-changing endpoint is POST-only
    const resGet = await app.fetch(
      new Request('http://localhost/api/ios/synced?task_id=x', {
        method: 'GET',
        headers: { Authorization: 'Bearer ios_bearer_token' },
      }),
      env
    );
    expect(resGet.status).toBe(404);
  });
});
