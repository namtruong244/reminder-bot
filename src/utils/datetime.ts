/**
 * Datetime utilities supporting Asia/Ho_Chi_Minh (+07:00) and UTC conversion.
 * Strictly uses Web Standard APIs (Intl.DateTimeFormat, Date).
 */

export const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

const VIETNAMESE_DAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

/**
 * Returns formatted Day of Week in Vietnamese (e.g., "Thứ Hai", "Chủ Nhật").
 */
export function getVietnameseDayOfWeek(date: Date = new Date(), timezone: string = DEFAULT_TZ): string {
  // Format to get weekday in target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const weekdayShort = formatter.format(date);
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const lookup: Record<string, string> = {};
  for (const part of parts) {
    lookup[part.type] = part.value;
  }

  // Calculate offset for target timezone
  const tzOffsetString = getTimezoneOffsetString(date, timezone);
  return `${lookup.year}-${lookup.month}-${lookup.day}T${lookup.hour}:${lookup.minute}:${lookup.second}${tzOffsetString}`;
}

/**
 * Returns timezone offset in "+HH:MM" or "-HH:MM" format.
 */
export function getTimezoneOffsetString(date: Date = new Date(), timezone: string = DEFAULT_TZ): string {
  // Asia/Ho_Chi_Minh has static +07:00 offset (no daylight saving time)
  if (timezone === 'Asia/Ho_Chi_Minh' || timezone === 'Asia/Bangkok' || timezone === 'Asia/Saigon') {
    return '+07:00';
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
 */
export function toUtcIso(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date input: ${input}`);
  }
  return date.toISOString();
}

/**
 * Formats an ISO string for display in Telegram message (e.g. "15:00 - 22/10/2026").
 */
export function formatDisplayDate(isoString: string, timezone: string = DEFAULT_TZ): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const lookup: Record<string, string> = {};
  for (const part of parts) {
    lookup[part.type] = part.value;
  }

  return `${lookup.hour}:${lookup.minute} - ${lookup.day}/${lookup.month}/${lookup.year}`;
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
 * Calculates tomorrow 09:00 AM in user's timezone, returning UTC ISO string.
 */
export function getTomorrowMorningIso(timezone: string = DEFAULT_TZ, hour = 9, minute = 0): string {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Format tomorrow date in target timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(tomorrow);

  const lookup: Record<string, string> = {};
  for (const p of parts) {
    lookup[p.type] = p.value;
  }

  const offset = getTimezoneOffsetString(tomorrow, timezone);
  const targetIso = `${lookup.year}-${lookup.month}-${lookup.day}T${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00${offset}`;
  return toUtcIso(targetIso);
}

/**
 * Advances recurrence for recurring tasks based on basic iCalendar RRULE.
 * Supports FREQ=DAILY, FREQ=WEEKLY, FREQ=MONTHLY and INTERVAL.
 */
export function calculateNextRecurrence(
  dueAtIso: string,
  remindAtIso: string,
  rrule: string
): { dueAt: string; remindAt: string } {
  const dueDate = new Date(dueAtIso);
  const remindDate = new Date(remindAtIso);
  const deltaRemind = dueDate.getTime() - remindDate.getTime();

  const upperRRule = rrule.toUpperCase();
  const freqMatch = upperRRule.match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/);
  const freq = freqMatch ? freqMatch[1] : 'DAILY';

  const intervalMatch = upperRRule.match(/INTERVAL=(\d+)/);
  const interval = intervalMatch ? parseInt(intervalMatch[1], 10) : 1;

  const nextDue = new Date(dueDate);

  if (freq === 'DAILY') {
    nextDue.setDate(nextDue.getDate() + interval);
  } else if (freq === 'WEEKLY') {
    nextDue.setDate(nextDue.getDate() + 7 * interval);
  } else if (freq === 'MONTHLY') {
    nextDue.setMonth(nextDue.getMonth() + interval);
  } else if (freq === 'YEARLY') {
    nextDue.setFullYear(nextDue.getFullYear() + interval);
  } else {
    nextDue.setDate(nextDue.getDate() + 1);
  }

  // If next due is still in the past, advance until future
  const now = Date.now();
  while (nextDue.getTime() <= now) {
    if (freq === 'DAILY') nextDue.setDate(nextDue.getDate() + interval);
    else if (freq === 'WEEKLY') nextDue.setDate(nextDue.getDate() + 7 * interval);
    else if (freq === 'MONTHLY') nextDue.setMonth(nextDue.getMonth() + interval);
    else if (freq === 'YEARLY') nextDue.setFullYear(nextDue.getFullYear() + interval);
    else nextDue.setDate(nextDue.getDate() + 1);
  }

  const nextDueIso = nextDue.toISOString();
  const nextRemindIso = new Date(nextDue.getTime() - deltaRemind).toISOString();

  return {
    dueAt: nextDueIso,
    remindAt: nextRemindIso,
  };
}
