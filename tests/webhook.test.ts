import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../src/index';
import { Env } from '../src/types/env';

// D1 mock whose processed_updates behaves like a PRIMARY KEY table (INSERT OR IGNORE)
function createD1(claimed: Set<number>, opts: { failClaim?: boolean } = {}): D1Database {
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} }),
    raw: async () => [],
    run: async () => {
      if (sql.includes('processed_updates')) {
        if (opts.failClaim) throw new Error('no such table: processed_updates');
        const id = params[0] as number;
        if (claimed.has(id)) return { success: true, results: [], meta: { changes: 0 } };
        claimed.add(id);
      }
      return { success: true, results: [], meta: { changes: 1 } };
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database;
}

const baseEnv = (db: D1Database): Env => ({
  DB: db,
  TELEGRAM_BOT_TOKEN: 'tok',
  TELEGRAM_WEBHOOK_SECRET: 'sec',
});

const update = (id: number) => ({
  update_id: id,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 42, type: 'private' },
    from: { id: 42, is_bot: false, first_name: 'T' },
    text: '/help',
  },
});

const post = (body: unknown) =>
  new Request('http://localhost/webhook/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'sec' },
    body: JSON.stringify(body),
  });

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext,
    pending,
  };
}

describe('Telegram webhook', () => {
  afterEach(() => vi.restoreAllMocks());

  it('acks immediately and does the work via waitUntil', async () => {
    let releaseTelegram!: () => void;
    const gate = new Promise<void>((r) => (releaseTelegram = r));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate; // Telegram API is "slow"
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const { ctx, pending } = makeCtx();
    const res = await app.fetch(post(update(1001)), baseEnv(createD1(new Set())), ctx);

    // Response is back while the Telegram call is still blocked
    expect(res.status).toBe(200);
    expect(pending.length).toBeGreaterThan(0);
    releaseTelegram();
    await Promise.all(pending);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('drops a duplicate update_id claimed in D1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} })));
    const claimed = new Set<number>();
    const env = baseEnv(createD1(claimed));

    const first = makeCtx();
    await app.fetch(post(update(2002)), env, first.ctx);
    await Promise.all(first.pending);
    const sentAfterFirst = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // Same update delivered again (even from a different isolate sharing D1)
    const second = makeCtx();
    const res = await app.fetch(post(update(2002)), env, second.ctx);
    await Promise.all(second.pending);

    expect(res.status).toBe(200);
    expect(second.pending.length).toBe(0);
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sentAfterFirst);
    expect(claimed.has(2002)).toBe(true);
  });

  it('still processes the update (in-memory guard) when processed_updates is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} })));
    const env = baseEnv(createD1(new Set(), { failClaim: true }));

    const a = makeCtx();
    await app.fetch(post(update(3003)), env, a.ctx);
    expect(a.pending.length).toBeGreaterThan(0);
    await Promise.all(a.pending);

    const b = makeCtx();
    await app.fetch(post(update(3003)), env, b.ctx);
    expect(b.pending.length).toBe(0); // duplicate caught by the fallback guard
  });

  it('rejects a wrong secret token before claiming anything', async () => {
    const claimed = new Set<number>();
    const res = await app.fetch(
      new Request('http://localhost/webhook/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'nope' },
        body: JSON.stringify(update(4004)),
      }),
      baseEnv(createD1(claimed)),
      makeCtx().ctx
    );
    expect(res.status).toBe(401);
    expect(claimed.size).toBe(0);
  });
});
