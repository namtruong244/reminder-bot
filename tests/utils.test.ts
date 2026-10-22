import { describe, it, expect } from 'vitest';
import { encryptText, decryptText } from '../src/utils/crypto';
import {
  formatDisplayDate,
  toUtcIso,
  toCompactUtcString,
  addMinutes,
  calculateNextRecurrence,
  getNowWithTimezone,
  getVietnameseDayOfWeek,
  getDayRangeUtc,
  escapeMarkdown,
  getDaysInMonth,
} from '../src/utils/datetime';
import { ICloudCalDavService } from '../src/services/icloud.service';

describe('Crypto Utils', () => {
  const secretKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('encrypts and decrypts text correctly with AES-256-GCM', async () => {
    const original = 'my-apple-app-specific-password-abcd-efgh-ijkl-mnop';
    const encrypted = await encryptText(original, secretKey);

    expect(encrypted).not.toEqual(original);
    expect(encrypted).toContain(':');

    const decrypted = await decryptText(encrypted, secretKey);
    expect(decrypted).toEqual(original);
  });

  it('fails decryption with wrong key', async () => {
    const original = 'secret-data';
    const encrypted = await encryptText(original, secretKey);
    const wrongKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

    await expect(decryptText(encrypted, wrongKey)).rejects.toThrow();
  });
});

describe('Datetime & Markdown Utils', () => {
  it('converts Vietnam local ISO to UTC ISO', () => {
    const vnTime = '2026-10-22T15:00:00+07:00';
    const utcIso = toUtcIso(vnTime);
    expect(utcIso).toBe('2026-10-22T08:00:00.000Z');
  });

  it('formats display date correctly in Asia/Ho_Chi_Minh', () => {
    const utcIso = '2026-10-22T08:00:00.000Z';
    const display = formatDisplayDate(utcIso, 'Asia/Ho_Chi_Minh');
    expect(display).toBe('15:00 - 22/10/2026');
  });

  it('formats midnight as 00:xx instead of 24:xx', () => {
    const midnightVnUtc = new Date('2026-10-21T17:05:00.000Z'); // 00:05 on 2026-10-22 in VN
    const iso = getNowWithTimezone(midnightVnUtc, 'Asia/Ho_Chi_Minh');
    expect(iso).toBe('2026-10-22T00:05:00+07:00');
  });

  it('formats compact UTC string for iCalendar', () => {
    const utcIso = '2026-10-22T08:00:00.000Z';
    const compact = toCompactUtcString(utcIso);
    expect(compact).toBe('20261022T080000Z');
  });

  it('adds minutes correctly', () => {
    const utcIso = '2026-10-22T08:00:00.000Z';
    const added = addMinutes(utcIso, 15);
    expect(added).toBe('2026-10-22T08:15:00.000Z');
  });

  it('calculates next recurrence for daily rule', () => {
    const dueAt = new Date(Date.now() + 3600000).toISOString();
    const remindAt = new Date(Date.now() + 3600000 - 15 * 60000).toISOString();
    const { dueAt: nextDue } = calculateNextRecurrence(dueAt, remindAt, 'FREQ=DAILY;INTERVAL=1');

    const nextDueDate = new Date(nextDue);
    const prevDueDate = new Date(dueAt);
    expect(nextDueDate.getTime() - prevDueDate.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('returns Vietnamese day of week', () => {
    const date = new Date('2026-10-21T08:00:00Z'); // Wednesday in 2026
    const day = getVietnameseDayOfWeek(date, 'Asia/Ho_Chi_Minh');
    expect(day).toBe('Thứ Tư');
  });

  it('calculates next recurrence for monthly rule with BYMONTHDAY=4', () => {
    const dueAt = '2026-10-04T02:00:00.000Z'; // 09:00 VN
    const remindAt = '2026-10-04T02:00:00.000Z';
    const { dueAt: nextDue } = calculateNextRecurrence(dueAt, remindAt, 'FREQ=MONTHLY;BYMONTHDAY=4');
    const nextDate = new Date(nextDue);
    expect(nextDate.getUTCDate()).toBe(4);
    expect(nextDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('clamps month-end recurrence without skipping February (Jan 31 -> Feb 28)', () => {
    const futureYear = new Date().getUTCFullYear() + 1;
    const dueAt = `${futureYear}-01-31T02:00:00.000Z`; // Jan 31 09:00 VN
    const remindAt = `${futureYear}-01-31T02:00:00.000Z`;
    const { dueAt: nextDue } = calculateNextRecurrence(
      dueAt,
      remindAt,
      'FREQ=MONTHLY;BYMONTHDAY=31',
      'Asia/Ho_Chi_Minh'
    );
    const expectedFebDays = getDaysInMonth(futureYear, 2);
    expect(nextDue).toBe(`${futureYear}-02-${expectedFebDays}T02:00:00.000Z`);
  });

  it('calculates getDayRangeUtc correctly in Asia/Ho_Chi_Minh', () => {
    const date = new Date('2026-10-22T03:00:00.000Z'); // 10:00 AM VN on Oct 22
    const { startUtc, endUtc } = getDayRangeUtc(date, 'Asia/Ho_Chi_Minh');
    expect(startUtc).toBe('2026-10-21T17:00:00.000Z');
    expect(endUtc).toBe('2026-10-22T16:59:59.999Z');
  });

  it('escapes special Telegram Markdown characters safely', () => {
    const raw = 'Review file_v1_final *urgent* `code` [link]';
    const escaped = escapeMarkdown(raw);
    expect(escaped).toBe('Review file\\_v1\\_final \\*urgent\\* \\`code\\` \\[link]');
  });

  it('builds valid CalDAV VTODO ICS payload', () => {
    const caldav = new ICloudCalDavService();
    const ics = caldav.buildVTodoIcs({
      id: 'uuid-test-1',
      user_id: 100,
      title: 'Gửi hợp đồng',
      description: 'Khách VIP',
      due_at: '2026-10-22T08:00:00.000Z',
      remind_at: '2026-10-22T07:45:00.000Z',
      priority: 'CRITICAL',
      status: 'PENDING',
      recurrence_rule: 'FREQ=DAILY',
      nagging_mode: 1,
      snooze_count: 0,
      ios_synced: 0,
    });
    expect(ics).toContain('BEGIN:VTODO');
    expect(ics).toContain('UID:uuid-test-1');
    expect(ics).toContain('DUE:20261022T080000Z');
    expect(ics).toContain('PRIORITY:1');
    expect(ics).toContain('RRULE:FREQ=DAILY');
  });
});
