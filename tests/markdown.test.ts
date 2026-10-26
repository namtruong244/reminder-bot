import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../src/index';
import { Env } from '../src/types/env';

import { markdownError } from './helpers/markdown';

describe('markdownError helper', () => {
  it('flags the original bug and accepts escapes', () => {
    expect(markdownError('_iOS: chờ (ios_synced: 0)_')).not.toBeNull();
    expect(markdownError('_iOS: chờ (ios\\_synced)_')).toBeNull();
    expect(markdownError('*bold* `a_b` _it_')).toBeNull();
    expect(markdownError('single_underscore')).not.toBeNull();
  });
});

const sent: Array<{ text: string; parse_mode?: string }> = [];

function createD1(): D1Database {
  const stmt = (): unknown => ({
    bind: () => stmt(),
    first: async () => ({ count: 0, timezone: 'Asia/Ho_Chi_Minh' }),
    all: async () => ({ results: [], success: true, meta: {} }),
    run: async () => ({ success: true, results: [], meta: { changes: 1 } }),
    raw: async () => [],
  });
  return { prepare: () => stmt(), batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) } as unknown as D1Database;
}

async function send(text: string, env: Partial<Env> = {}): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const full: Env = { DB: createD1(), TELEGRAM_BOT_TOKEN: 't', ...env };
  await app.fetch(
    new Request('http://localhost/webhook/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 1e9),
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 7, type: 'private' },
          from: { id: 7, is_bot: false, first_name: 'T' },
          text,
        },
      }),
    }),
    full,
    { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext
  );
  await Promise.all(pending);
}

describe('Telegram messages are valid legacy Markdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sent.length = 0;
  });

  const captureTelegram = () =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (typeof body.text === 'string') sent.push({ text: body.text, parse_mode: body.parse_mode });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

  const expectAllValid = (requireSome = true) => {
    const withMd = sent.filter((m) => m.parse_mode === 'Markdown');
    if (requireSome) expect(withMd.length).toBeGreaterThan(0);
    for (const m of withMd) {
      expect(markdownError(m.text), `\n${m.text}`).toBeNull();
    }
  };

  for (const cmd of ['/start', '/help', '/sync', '/list', '/today', '/debug']) {
    it(`${cmd} (with and without Gemini key)`, async () => {
      captureTelegram();
      await send(cmd);
      await send(cmd, { GEMINI_API_KEY: 'AQ.fake_key_value_123456' });
      // empty /list and /today answer in plain text
      expectAllValid(!['/list', '/today'].includes(cmd));
    });
  }

  it('task confirmation without Gemini key (regex path, recurring, critical)', async () => {
    captureTelegram();
    await send('thứ 2 và thứ 4 hàng tuần đi gym 6h sáng, việc gấp');
    await send('nhắc tôi gọi điện cho anh Mai'); // time assumed
    await send('mai 9h họp_nhóm *quan trọng*'); // user text with markdown characters
    expectAllValid();
    // the confirmation for the first message really was sent with bold fields
    expect(sent.some((m) => m.text.includes('Đã tạo nhắc nhở'))).toBe(true);
  });

  it('task confirmation when Gemini fails (regex fallback with error text)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('generativelanguage')) {
        return new Response('{"error":{"message":"quota_exceeded: key_x"}}', { status: 429 });
      }
      const body = JSON.parse(String((init as RequestInit).body));
      if (typeof body.text === 'string') sent.push({ text: body.text, parse_mode: body.parse_mode });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
    await send('mai 9h họp', { GEMINI_API_KEY: 'AQ.fake' });
    await send('/debug mai 9h họp_nhóm', { GEMINI_API_KEY: 'AQ.fake' });
    expectAllValid();
  });
});
