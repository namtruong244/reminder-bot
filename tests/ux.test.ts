import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../src/index';
import { Env } from '../src/types/env';
import { TaskRecord } from '../src/types/task';
import {
  formatFriendlyDate,
  formatDayLabel,
  formatCountdown,
  describeRecurrence,
} from '../src/utils/datetime';
import {
  renderCreatedMessage,
  renderReminderMessage,
  renderTaskCard,
  renderTaskList,
} from '../src/bot/messages';
import { markdownError } from './helpers/markdown';

// Monday 2026-10-26 08:00 (+07:00)
const NOW = new Date('2026-10-26T08:00:00+07:00');
const TZ = 'Asia/Ho_Chi_Minh';
const at = (iso: string) => new Date(iso).toISOString();

describe('date helpers', () => {
  it('formats friendly dates relative to today', () => {
    expect(formatFriendlyDate(at('2026-10-26T15:00:00+07:00'), TZ, NOW)).toBe('Hôm nay 15:00');
    expect(formatFriendlyDate(at('2026-10-27T09:00:00+07:00'), TZ, NOW)).toBe('Ngày mai 09:00');
    expect(formatFriendlyDate(at('2026-10-28T09:00:00+07:00'), TZ, NOW)).toBe('Ngày mốt 09:00');
    expect(formatFriendlyDate(at('2026-10-30T09:00:00+07:00'), TZ, NOW)).toBe('Thứ Sáu 30/10 09:00');
    expect(formatFriendlyDate(at('2026-12-20T09:00:00+07:00'), TZ, NOW)).toBe('20/12 09:00');
    expect(formatFriendlyDate(at('2027-01-05T09:00:00+07:00'), TZ, NOW)).toBe('05/01/2027 09:00');
    expect(formatDayLabel(at('2026-10-25T09:00:00+07:00'), TZ, NOW)).toBe('Hôm qua');
  });

  it('uses the user timezone for the day boundary', () => {
    // 23:30 UTC on the 26th is already the 27th in Vietnam
    expect(formatDayLabel('2026-10-26T23:30:00Z', TZ, NOW)).toBe('Ngày mai');
  });

  it('formats countdowns', () => {
    expect(formatCountdown(at('2026-10-26T08:15:00+07:00'), NOW)).toBe('còn 15 phút');
    expect(formatCountdown(at('2026-10-26T10:05:00+07:00'), NOW)).toBe('còn 2 giờ 5 phút');
    expect(formatCountdown(at('2026-10-26T11:00:00+07:00'), NOW)).toBe('còn 3 giờ');
    expect(formatCountdown(at('2026-10-29T08:00:00+07:00'), NOW)).toBe('còn 3 ngày');
    expect(formatCountdown(at('2026-10-26T07:50:00+07:00'), NOW)).toBe('quá hạn 10 phút');
  });

  it('describes recurrence rules in Vietnamese', () => {
    expect(describeRecurrence('FREQ=DAILY')).toBe('Hàng ngày');
    expect(describeRecurrence('FREQ=WEEKLY;BYDAY=MO,WE')).toBe('Hàng tuần: Thứ 2, Thứ 4');
    expect(describeRecurrence('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('Ngày 15 hàng tháng');
    expect(describeRecurrence('FREQ=DAILY;INTERVAL=3')).toBe('Mỗi 3 ngày');
    expect(describeRecurrence('WEIRD')).toBe('WEIRD');
  });
});

const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 't1',
  user_id: 7,
  title: 'Gửi hợp đồng_cho *khách*',
  description: null,
  due_at: at('2026-10-27T15:00:00+07:00'),
  remind_at: at('2026-10-27T14:45:00+07:00'),
  priority: 'CRITICAL',
  status: 'PENDING',
  recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE',
  nagging_mode: 1,
  snooze_count: 2,
  ios_synced: 0,
  ...over,
});

describe('message rendering', () => {
  it('renders a readable card without raw RRULE or debug text', () => {
    const card = renderTaskCard(task(), TZ, NOW);
    expect(card).toContain('⏰ Ngày mai 15:00 · còn 1 ngày 7 giờ');
    expect(card).toContain('🔔 Nhắc trước lúc ngày mai 14:45');
    expect(card).toContain('🔴 Khẩn cấp · 🔁 nhắc lại mỗi 10 phút');
    expect(card).toContain('🔄 Hàng tuần: Thứ 2, Thứ 4');
    expect(card).not.toContain('FREQ=');
  });

  it('all rendered messages are valid Telegram Markdown (even with special chars in titles)', () => {
    const t = task({ description: 'ghi_chú *quan trọng*' });
    const list = renderTaskList([t, task({ id: 't2', due_at: at('2026-10-26T09:00:00+07:00'), priority: 'MEDIUM', recurrence_rule: null })], TZ, { heading: '📋 *Việc đang chờ*' }, NOW);
    const messages = [
      renderCreatedMessage(t, TZ, { timeAssumed: true, aiFallback: true }, NOW),
      renderReminderMessage(t, TZ, NOW),
      renderReminderMessage(task({ nagging_mode: 0, priority: 'MEDIUM', snooze_count: 0 }), TZ, NOW),
      list.text,
    ];
    for (const m of messages) expect(markdownError(m), `\n${m}`).toBeNull();
  });

  it('groups the list by day and flags overdue items', () => {
    const view = renderTaskList(
      [
        task({ id: 'a', title: 'Quá hạn', due_at: at('2026-10-26T07:00:00+07:00'), recurrence_rule: null, nagging_mode: 0 }),
        task({ id: 'b', title: 'Hôm nay', due_at: at('2026-10-26T15:00:00+07:00'), recurrence_rule: null, nagging_mode: 0 }),
        task({ id: 'c', title: 'Ngày mai', due_at: at('2026-10-27T09:00:00+07:00'), recurrence_rule: null, nagging_mode: 0 }),
      ],
      TZ,
      { heading: '📋 *Việc đang chờ*' },
      NOW
    );
    expect(view.text).toContain('*⚠️ Quá hạn*');
    expect(view.text).toContain('*Hôm nay*');
    expect(view.text).toContain('*Ngày mai*');
    expect(view.text).toContain('2. 🔴 15:00 · Hôm nay');
    expect(view.keyboard.inline_keyboard).toHaveLength(3);
    expect(view.keyboard.inline_keyboard[0][0].callback_data).toBe('action:done:a:l');
  });

  it('caps the list at 10 rows and says how many were hidden', () => {
    const many = Array.from({ length: 13 }, (_, i) => task({ id: `x${i}`, title: `Việc ${i}`, recurrence_rule: null }));
    const view = renderTaskList(many, TZ, { heading: '📋 *Việc đang chờ*' }, NOW);
    expect(view.keyboard.inline_keyboard).toHaveLength(10);
    expect(view.text).toContain('…và 3 việc khác');
  });
});

// ---------- callback flows against a stateful D1 mock ----------

function createStatefulD1(row: TaskRecord) {
  const state = { row: { ...row }, claimed: new Set<number>() };
  const stmt = (sql: string, params: unknown[] = []): unknown => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    first: async () => {
      if (sql.includes('FROM users')) return { telegram_id: 7, timezone: TZ };
      if (sql.includes('FROM tasks WHERE id')) return { ...state.row };
      return null;
    },
    all: async () => {
      if (sql.includes('FROM tasks') && sql.includes('user_id')) {
        const open = state.row.status === 'PENDING';
        return { results: open ? [{ ...state.row }] : [], success: true, meta: {} };
      }
      return { results: [], success: true, meta: {} };
    },
    run: async () => {
      if (sql.includes('processed_updates')) {
        const id = params[0] as number;
        if (state.claimed.has(id)) return { success: true, results: [], meta: { changes: 0 } };
        state.claimed.add(id);
      } else if (sql.includes("SET status = 'COMPLETED'")) state.row.status = 'COMPLETED';
      else if (sql.includes("SET status = 'CANCELLED'")) state.row.status = 'CANCELLED';
      else if (sql.includes("SET status = 'PENDING', remind_at")) {
        state.row.status = 'PENDING';
        state.row.remind_at = params[0] as string;
      } else if (sql.includes('SET due_at = ?, remind_at = ?, ios_synced = 0')) {
        state.row.due_at = params[0] as string;
        state.row.remind_at = params[1] as string;
      } else if (sql.includes('snooze_count = snooze_count + 1')) {
        state.row.remind_at = params[0] as string;
      }
      return { success: true, results: [], meta: { changes: 1 } };
    },
    raw: async () => [],
  });
  const db = { prepare: (sql: string) => stmt(sql), batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) } as unknown as D1Database;
  return { db, state };
}

type Call = { method: string; body: Record<string, any> };
let nextUpdateId = 9000;

async function tap(env: Env, data: string, fromId = 7): Promise<Call[]> {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ method: String(url).split('/').pop()!, body: JSON.parse(String((init as RequestInit).body)) });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  const pending: Promise<unknown>[] = [];
  await app.fetch(
    new Request('http://localhost/webhook/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: nextUpdateId++,
        callback_query: {
          id: 'cb1',
          from: { id: fromId, is_bot: false, first_name: 'T' },
          message: { message_id: 55, date: 0, chat: { id: fromId, type: 'private' } },
          data,
        },
      }),
    }),
    env,
    { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext
  );
  await Promise.all(pending);
  return calls;
}

const keyboardData = (c?: Call) =>
  JSON.stringify(c?.body.reply_markup?.inline_keyboard ?? []);

describe('callback flows', () => {
  afterEach(() => vi.restoreAllMocks());

  const setup = (over: Partial<TaskRecord> = {}) => {
    const { db, state } = createStatefulD1(
      task({ priority: 'MEDIUM', nagging_mode: 0, recurrence_rule: null, due_at: new Date(Date.now() + 86400000).toISOString(), remind_at: new Date(Date.now() + 86400000).toISOString(), ...over })
    );
    return { env: { DB: db, TELEGRAM_BOT_TOKEN: 't' } as Env, state };
  };

  it('Done shows an undo button, Undo restores the task with its normal buttons', async () => {
    const { env, state } = setup();
    const done = await tap(env, 'action:done:t1');
    const edit = done.find((c) => c.method === 'editMessageText')!;
    expect(state.row.status).toBe('COMPLETED');
    expect(edit.body.text).toContain('Đã hoàn thành');
    expect(keyboardData(edit)).toContain('action:undo:t1');

    const undo = await tap(env, 'action:undo:t1');
    const restored = undo.find((c) => c.method === 'editMessageText')!;
    expect(state.row.status).toBe('PENDING');
    expect(restored.body.text).toContain('Đã khôi phục');
    expect(keyboardData(restored)).toContain('action:edit:t1');
  });

  it('a second tap on Done is harmless', async () => {
    const { env } = setup();
    await tap(env, 'action:done:t1');
    const again = await tap(env, 'action:done:t1');
    expect(again.some((c) => c.method === 'editMessageText')).toBe(false);
    expect(again.find((c) => c.method === 'answerCallbackQuery')!.body.text).toContain('đã hoàn thành');
  });

  it('Cancel offers undo as well', async () => {
    const { env, state } = setup();
    const res = await tap(env, 'action:cancel:t1');
    expect(state.row.status).toBe('CANCELLED');
    expect(keyboardData(res.find((c) => c.method === 'editMessageText'))).toContain('action:undo:t1');
  });

  it('"Sửa giờ" swaps only the keyboard to presets and "Quay lại" restores it', async () => {
    const { env } = setup();
    const open = await tap(env, 'action:edit:t1');
    expect(open.some((c) => c.method === 'editMessageText')).toBe(false);
    const presets = keyboardData(open.find((c) => c.method === 'editMessageReplyMarkup'));
    expect(presets).toContain('action:resched:tomorrow:t1');
    expect(presets).toContain('action:back:t1');

    const back = await tap(env, 'action:back:t1');
    expect(keyboardData(back.find((c) => c.method === 'editMessageReplyMarkup'))).toContain('action:edit:t1');
  });

  it('rescheduling moves the due time and redraws the card', async () => {
    const { env, state } = setup();
    const before = state.row.due_at;
    const res = await tap(env, 'action:resched:tomorrow14:t1');
    expect(state.row.due_at).not.toBe(before);
    const edit = res.find((c) => c.method === 'editMessageText')!;
    expect(edit.body.text).toContain('Đã đổi giờ');
    expect(edit.body.text).toContain('14:00');
  });

  it('Done from the list refreshes the list in place', async () => {
    const { env } = setup();
    const res = await tap(env, 'action:done:t1:l');
    const edit = res.find((c) => c.method === 'editMessageText')!;
    expect(edit.body.text).toContain('Không còn việc nào đang chờ');
    expect(edit.body.reply_markup).toBeUndefined();
  });

  it("refuses to touch another user's task", async () => {
    const { env, state } = setup({ user_id: 99 });
    const res = await tap(env, 'action:done:t1');
    expect(state.row.status).toBe('PENDING');
    const toast = res.find((c) => c.method === 'answerCallbackQuery')!;
    expect(toast.body.show_alert).toBe(true);
  });
});
