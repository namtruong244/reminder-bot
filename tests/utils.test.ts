import { describe, it, expect } from 'vitest';
import { encryptText, decryptText } from '../src/utils/crypto';
import {
  formatDisplayDate,
  toUtcIso,
  toCompactUtcString,
  addMinutes,
  addDays,
  calculateNextRecurrence,
  getNowWithTimezone,
  getVietnameseDayOfWeek,
} from '../src/utils/datetime';

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

describe('Datetime Utils', () => {
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
    const { dueAt: nextDue, remindAt: nextRemind } = calculateNextRecurrence(dueAt, remindAt, 'FREQ=DAILY;INTERVAL=1');

    const nextDueDate = new Date(nextDue);
    const prevDueDate = new Date(dueAt);
    expect(nextDueDate.getTime() - prevDueDate.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('returns Vietnamese day of week', () => {
    const date = new Date('2026-10-21T08:00:00Z'); // Wednesday in 2026
    const day = getVietnameseDayOfWeek(date, 'Asia/Ho_Chi_Minh');
    expect(day).toBe('Thứ Tư');
  });
});
