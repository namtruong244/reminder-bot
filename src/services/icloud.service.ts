import { TaskRecord, UserRecord, CalDavSyncResult } from '../types/task';
import { toCompactUtcString } from '../utils/datetime';
import { decryptText } from '../utils/crypto';

export class ICloudService {
  constructor(private encryptionSecretKey?: string) {}

  /**
   * Generates standard iCalendar VTODO format with VALARM for iOS alerts.
   */
  generateVTodoIcs(
    task: TaskRecord,
    status: 'NEEDS-ACTION' | 'COMPLETED' | 'CANCELLED' = 'NEEDS-ACTION'
  ): string {
    const nowUtcCompact = toCompactUtcString(new Date());
    const dueUtcCompact = toCompactUtcString(task.due_at);

    // Map priority: CRITICAL -> 1, HIGH -> 3, MEDIUM -> 5, LOW -> 9
    const priorityNumber =
      task.priority === 'CRITICAL' ? 1 :
      task.priority === 'HIGH' ? 3 :
      task.priority === 'LOW' ? 9 : 5;

    const descriptionLine = task.description
      ? `DESCRIPTION:${task.description.replace(/\n/g, '\\n')}\r\n`
      : '';

    const completedLine =
      status === 'COMPLETED'
        ? `COMPLETED:${nowUtcCompact}\r\n`
        : '';

    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CFWorker Telegram Bot//VN',
      'BEGIN:VTODO',
      `UID:${task.id}`,
      `DTSTAMP:${nowUtcCompact}`,
      `DUE:${dueUtcCompact}`,
      `SUMMARY:${task.title.replace(/\n/g, ' ')}`,
      descriptionLine ? descriptionLine.trim() : null,
      `PRIORITY:${priorityNumber}`,
      `STATUS:${status}`,
      completedLine ? completedLine.trim() : null,
      'BEGIN:VALARM',
      'TRIGGER:-PT0M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'END:VALARM',
      'END:VTODO',
      'END:VCALENDAR',
    ]
      .filter(Boolean)
      .join('\r\n');
  }

  /**
   * Syncs a task to iCloud CalDAV directly using HTTP PUT.
   */
  async syncTaskToCalDav(
    user: UserRecord,
    task: TaskRecord,
    status: 'NEEDS-ACTION' | 'COMPLETED' | 'CANCELLED' = 'NEEDS-ACTION'
  ): Promise<CalDavSyncResult> {
    if (!user.icloud_apple_id || !user.icloud_app_password_enc || !user.icloud_calendar_url) {
      return { success: false, error: 'iCloud not configured for user' };
    }

    try {
      const secret = this.encryptionSecretKey || 'default-fallback-32-byte-secret-key-32';
      const appPassword = await decryptText(user.icloud_app_password_enc, secret);
      const authHeader = `Basic ${btoa(`${user.icloud_apple_id}:${appPassword}`)}`;

      const calendarUrl = user.icloud_calendar_url.replace(/\/$/, '');
      const taskUrl = `${calendarUrl}/${task.id}.ics`;

      const icsContent = this.generateVTodoIcs(task, status);

      const headers: Record<string, string> = {
        Authorization: authHeader,
        'Content-Type': 'text/calendar; charset=utf-8',
      };

      if (task.caldav_etag) {
        headers['If-Match'] = task.caldav_etag;
      }

      const response = await fetch(taskUrl, {
        method: 'PUT',
        headers,
        body: icsContent,
      });

      if (!response.ok && response.status !== 412) {
        const errorText = await response.text();
        console.error(`iCloud CalDAV PUT failed (${response.status}):`, errorText);
        return { success: false, error: `CalDAV error: ${response.status}` };
      }

      const etag = response.headers.get('ETag');
      return { success: true, etag };
    } catch (err) {
      console.error('Error during CalDAV sync:', err);
      return { success: false, error: String(err) };
    }
  }

  /**
   * Deletes a task from iCloud CalDAV.
   */
  async deleteTaskFromCalDav(user: UserRecord, taskId: string): Promise<boolean> {
    if (!user.icloud_apple_id || !user.icloud_app_password_enc || !user.icloud_calendar_url) {
      return false;
    }

    try {
      const secret = this.encryptionSecretKey || 'default-fallback-32-byte-secret-key-32';
      const appPassword = await decryptText(user.icloud_app_password_enc, secret);
      const authHeader = `Basic ${btoa(`${user.icloud_apple_id}:${appPassword}`)}`;
      const calendarUrl = user.icloud_calendar_url.replace(/\/$/, '');
      const taskUrl = `${calendarUrl}/${taskId}.ics`;

      const res = await fetch(taskUrl, {
        method: 'DELETE',
        headers: { Authorization: authHeader },
      });

      return res.ok || res.status === 404;
    } catch (err) {
      console.error('Error deleting from CalDAV:', err);
      return false;
    }
  }
}
