/**
 * Datetime utilities supporting Asia/Ho_Chi_Minh (+07:00) and arbitrary IANA timezones.
 * Strictly uses Web Standard APIs (Intl.DateTimeFormat, Date).
 */

export const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

/**
 * Escapes special characters for Telegram legacy 'Markdown' parse_mode
 * to prevent HTTP 400 entity parsing failures when interpolating user text.
 */
export function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([_*`\[])/g, '\\$1');
}

/**
 * Returns the number of days in a specific month (month is 1-indexed: 1 = Jan, 12 = Dec).
 */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Extracts calendar and clock components in the target timezone with guaranteed 00-23 hour range.
 */
export function getLocalDateParts(
  date: Date = new Date(),
  timezone: string = DEFAULT_TZ
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekdayShort: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);

  const lookup: Record<string, string> = {};
  for (const part of parts) {
    lookup[part.type] = part.value;
  }

  const rawHour = parseInt(lookup.hour || '0', 10);
  return {
    year: parseInt(lookup.year, 10),
    month: parseInt(lookup.month, 10),
    day: parseInt(lookup.day, 10),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: parseInt(lookup.minute || '0', 10),
    second: parseInt(lookup.second || '0', 10),
    weekdayShort: lookup.weekday || 'Mon',
  };
}

/**
 * Returns formatted Day of Week in Vietnamese (e.g., "Thứ Hai", "Chủ Nhật").
 */
export function getVietnameseDayOfWeek(date: Date = new Date(), timezone: string = DEFAULT_TZ): string {
  const { weekdayShort } = getLocalDateParts(date, timezone);
  const map: Record<string, string> = {
    Sun: 'Chủ Nhật',
    Mon: 'Thứ Hai',
    Tue: 'Thứ Ba',
    Wed: 'Thứ Tư',
    Thu: 'Thứ Năm',
    Fri: 'Thứ Sáu',
    Sat: 'Thứ Bảy',
  };
  return map[weekdayShort] || 'Thứ Hai';
}

/**
 * Formats a Date into ISO-like string with target timezone offset (e.g. "2026-10-21T15:00:00+07:00").
 */
export function getNowWithTimezone(date: Date = new Date(), timezone: string = DEFAULT_TZ): string {
  const p = getLocalDateParts(date, timezone);
  const yyyy = p.year.toString().padStart(4, '0');
  const mm = p.month.toString().padStart(2, '0');
  const dd = p.day.toString().padStart(2, '0');
  const hh = p.hour.toString().padStart(2, '0');
  const mi = p.minute.toString().padStart(2, '0');
  const ss = p.second.toString().padStart(2, '0');

  const tzOffsetString = getTimezoneOffsetString(date, timezone);
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${tzOffsetString}`;
}

/**
 * Returns timezone offset in "+HH:MM" or "-HH:MM" format.
 */
export function getTimezoneOffsetString(date: Date = new Date(), timezone: string = DEFAULT_TZ): string {
  if (timezone === 'Asia/Ho_Chi_Minh' || timezone === 'Asia/Bangkok' || timezone === 'Asia/Saigon') {
    return '+07:00';
  }
  if (timezone === 'UTC' || timezone === 'Etc/UTC' || timezone === 'GMT') {
    return '+00:00';
  }

  try {
    const offsetParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const tzName = offsetParts.find((p) => p.type === 'timeZoneName')?.value;
    if (tzName) {
      if (tzName === 'GMT' || tzName === 'UTC') return '+00:00';
      const match = tzName.match(/GMT([+-]\d{2}:\d{2})/);
      if (match) return match[1];
    }
  } catch {
    // Fallback to date diff calculation below
  }

  try {
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    const diffMin = Math.round((tzDate.getTime() - utcDate.getTime()) / 60000);
    const sign = diffMin >= 0 ? '+' : '-';
    const absMin = Math.abs(diffMin);
    const hours = Math.floor(absMin / 60).toString().padStart(2, '0');
    const minutes = (absMin % 60).toString().padStart(2, '0');
    return `${sign}${hours}:${minutes}`;
  } catch {
    return '+07:00';
  }
}

/**
 * Parses any ISO string (or Date) and returns standard UTC ISO string (e.g., "2026-10-21T08:00:00.000Z").
 * If the input string has no timezone offset, it is assumed to be in the user's timezone.
 */
export function toUtcIso(input: string | Date, timezone: string = DEFAULT_TZ): string {
  if (input instanceof Date) {
    if (isNaN(input.getTime())) {
      throw new Error('Invalid Date object');
    }
    return input.toISOString();
  }

  const str = input.trim();
  // If string already has explicit offset: +HH:MM, -HH:MM, or ends with Z
  if (/(?:[+-]\d{2}:?\d{2}|Z)$/i.test(str)) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // If no timezone offset (e.g. "2026-10-21T16:30:00" or "2026-10-21 16:30:00")
  const offset = getTimezoneOffsetString(new Date(), timezone);
  const normalized = str.replace(' ', 'T');
  const withOffset = `${normalized}${offset}`;
  const d = new Date(withOffset);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }

  const fallback = new Date(str);
  if (isNaN(fallback.getTime())) {
    throw new Error(`Invalid date input: ${input}`);
  }
  return fallback.toISOString();
}

/**
 * Formats an ISO string for display in Telegram message (e.g. "15:00 - 22/10/2026").
 */
export function formatDisplayDate(isoString: string, timezone: string = DEFAULT_TZ): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;

  const p = getLocalDateParts(date, timezone);
  const hh = p.hour.toString().padStart(2, '0');
  const mi = p.minute.toString().padStart(2, '0');
  const dd = p.day.toString().padStart(2, '0');
  const mm = p.month.toString().padStart(2, '0');
  const yyyy = p.year.toString().padStart(4, '0');

  return `${hh}:${mi} - ${dd}/${mm}/${yyyy}`;
}

/**
 * Formats date into compact iCalendar UTC format (e.g. "20261021T080000Z").
 */
export function toCompactUtcString(input: string | Date = new Date()): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(date.getTime())) {
    return new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * Adds minutes to an ISO string or Date, returning a new UTC ISO string.
 */
export function addMinutes(input: string | Date, minutes: number): string {
  const date = typeof input === 'string' ? new Date(input) : new Date(input.getTime());
  date.setTime(date.getTime() + minutes * 60 * 1000);
  return date.toISOString();
}

/**
 * Adds hours to an ISO string or Date, returning a new UTC ISO string.
 */
export function addHours(input: string | Date, hours: number): string {
  return addMinutes(input, hours * 60);
}

/**
 * Adds days to an ISO string or Date, returning a new UTC ISO string.
 */
export function addDays(input: string | Date, days: number): string {
  return addMinutes(input, days * 24 * 60);
}

/**
 * Calculates tomorrow 09:00 AM in user's timezone (DST-safe calendar day addition), returning UTC ISO string.
 */
export function getTomorrowMorningIso(timezone: string = DEFAULT_TZ, hour = 9, minute = 0): string {
  const nowParts = getLocalDateParts(new Date(), timezone);
  const tomorrowUtc = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1));

  const yy = tomorrowUtc.getUTCFullYear().toString().padStart(4, '0');
  const mm = (tomorrowUtc.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = tomorrowUtc.getUTCDate().toString().padStart(2, '0');
  const hh = hour.toString().padStart(2, '0');
  const mi = minute.toString().padStart(2, '0');

  const offset = getTimezoneOffsetString(tomorrowUtc, timezone);
  const targetIso = `${yy}-${mm}-${dd}T${hh}:${mi}:00${offset}`;
  return toUtcIso(targetIso, timezone);
}

/**
 * Returns UTC range (start of day, end of day) for a date in the given timezone.
 * Start: YYYY-MM-DDT00:00:00 in timezone -> UTC ISO
 * End: Next calendar day 00:00:00 minus 1ms in timezone -> UTC ISO
 */
export function getDayRangeUtc(
  date: Date = new Date(),
  timezone: string = DEFAULT_TZ
): { startUtc: string; endUtc: string } {
  const p = getLocalDateParts(date, timezone);
  const yy = p.year.toString().padStart(4, '0');
  const mm = p.month.toString().padStart(2, '0');
  const dd = p.day.toString().padStart(2, '0');

  const offset = getTimezoneOffsetString(date, timezone);
  const startLocalIso = `${yy}-${mm}-${dd}T00:00:00${offset}`;
  const startUtc = toUtcIso(startLocalIso, timezone);

  const nextDayUtc = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const nextYy = nextDayUtc.getUTCFullYear().toString().padStart(4, '0');
  const nextMm = (nextDayUtc.getUTCMonth() + 1).toString().padStart(2, '0');
  const nextDd = nextDayUtc.getUTCDate().toString().padStart(2, '0');
  const nextOffset = getTimezoneOffsetString(nextDayUtc, timezone);
  const nextDayStartUtc = toUtcIso(`${nextYy}-${nextMm}-${nextDd}T00:00:00${nextOffset}`, timezone);

  const endUtc = new Date(new Date(nextDayStartUtc).getTime() - 1).toISOString();

  return { startUtc, endUtc };
}

/**
 * Advances recurrence for recurring tasks based on iCalendar RRULE in the user's timezone.
 * Supports FREQ=DAILY, FREQ=WEEKLY, FREQ=MONTHLY, FREQ=YEARLY, INTERVAL, BYMONTHDAY, and BYDAY.
 * Preserves exact sub-second milliseconds and avoids JS Date.setMonth() overflow on month-end dates.
 */
export function calculateNextRecurrence(
  dueAtIso: string,
  remindAtIso: string,
  rrule: string,
  timezone: string = DEFAULT_TZ
): { dueAt: string; remindAt: string } {
  const dueDate = new Date(dueAtIso);
  const remindDate = new Date(remindAtIso);
  const deltaRemind = Math.max(0, dueDate.getTime() - remindDate.getTime());

  const upperRRule = rrule.toUpperCase();
  const freqMatch = upperRRule.match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/);
  const freq = freqMatch ? freqMatch[1] : 'DAILY';

  const intervalMatch = upperRRule.match(/INTERVAL=(\d+)/);
  const interval = Math.max(1, intervalMatch ? parseInt(intervalMatch[1], 10) : 1);

  const byMonthDayMatch = upperRRule.match(/BYMONTHDAY=(\d+)/);
  const byMonthDay = byMonthDayMatch ? parseInt(byMonthDayMatch[1], 10) : null;

  const byDayMatch = upperRRule.match(/BYDAY=([A-Z]{2})/);
  const byDay = byDayMatch ? byDayMatch[1] : null;

  const initialParts = getLocalDateParts(dueDate, timezone);
  let curYear = initialParts.year;
  let curMonth = initialParts.month; // 1..12
  let curDay = initialParts.day;
  const targetHour = initialParts.hour;
  const targetMinute = initialParts.minute;
  const targetSecond = initialParts.second;
  const targetMilliseconds = dueDate.getUTCMilliseconds();
  const preferredMonthDay = byMonthDay !== null ? byMonthDay : initialParts.day;

  const buildUtcDate = (y: number, m: number, d: number): Date => {
    const yy = y.toString().padStart(4, '0');
    const mm = m.toString().padStart(2, '0');
    const dd = d.toString().padStart(2, '0');
    const hh = targetHour.toString().padStart(2, '0');
    const mi = targetMinute.toString().padStart(2, '0');
    const ss = targetSecond.toString().padStart(2, '0');
    const ms = targetMilliseconds.toString().padStart(3, '0');
    const approxUtc = new Date(Date.UTC(y, m - 1, d, targetHour, targetMinute, targetSecond, targetMilliseconds));
    const offset = getTimezoneOffsetString(approxUtc, timezone);
    return new Date(`${yy}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}${offset}`);
  };

  const advanceOnce = () => {
    if (freq === 'DAILY') {
      const next = new Date(Date.UTC(curYear, curMonth - 1, curDay + interval));
      curYear = next.getUTCFullYear();
      curMonth = next.getUTCMonth() + 1;
      curDay = next.getUTCDate();
    } else if (freq === 'WEEKLY') {
      if (byDay) {
        const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
        const targetWeekday = dayMap[byDay] ?? 1;
        const curUtc = new Date(Date.UTC(curYear, curMonth - 1, curDay));
        const currentWeekday = curUtc.getUTCDay();
        let daysToAdd = (targetWeekday - currentWeekday + 7) % 7;
        if (daysToAdd === 0) daysToAdd = 7 * interval;
        const next = new Date(Date.UTC(curYear, curMonth - 1, curDay + daysToAdd));
        curYear = next.getUTCFullYear();
        curMonth = next.getUTCMonth() + 1;
        curDay = next.getUTCDate();
      } else {
        const next = new Date(Date.UTC(curYear, curMonth - 1, curDay + 7 * interval));
        curYear = next.getUTCFullYear();
        curMonth = next.getUTCMonth() + 1;
        curDay = next.getUTCDate();
      }
    } else if (freq === 'MONTHLY') {
      const totalMonths = curYear * 12 + (curMonth - 1) + interval;
      curYear = Math.floor(totalMonths / 12);
      curMonth = (totalMonths % 12) + 1;
      curDay = Math.min(preferredMonthDay, getDaysInMonth(curYear, curMonth));
    } else if (freq === 'YEARLY') {
      curYear += interval;
      curDay = Math.min(preferredMonthDay, getDaysInMonth(curYear, curMonth));
    } else {
      const next = new Date(Date.UTC(curYear, curMonth - 1, curDay + 1));
      curYear = next.getUTCFullYear();
      curMonth = next.getUTCMonth() + 1;
      curDay = next.getUTCDate();
    }
  };

  advanceOnce();
  let nextDue = buildUtcDate(curYear, curMonth, curDay);

  // If next due is still in the past, advance until future
  const now = Date.now();
  let iterations = 0;
  while (nextDue.getTime() <= now && iterations < 100) {
    advanceOnce();
    nextDue = buildUtcDate(curYear, curMonth, curDay);
    iterations++;
  }

  const nextDueIso = nextDue.toISOString();
  const nextRemindIso = new Date(nextDue.getTime() - deltaRemind).toISOString();

  return {
    dueAt: nextDueIso,
    remindAt: nextRemindIso,
  };
}
