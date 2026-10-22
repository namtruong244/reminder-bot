import { CalDavConfig, CalDavSyncResult, TaskPriority, TaskRecord, UserRecord } from '../types/task';
import { decryptText } from '../utils/crypto';
import { toCompactUtcString } from '../utils/datetime';

/**
 * Adapter A: Cloud-to-Cloud CalDAV (VTODO) Synchronization Service with Apple iCloud.
 * Uses pure Web Standard fetch & WebCrypto APIs with zero Node.js native dependencies.
 */
export class ICloudCalDavService {
  constructor(private encryptionSecretKey?: string) {}

  /**
   * Maps internal priority to iCalendar VTODO priority integer (1 = High, 5 = Medium, 9 = Low).
   */
  private mapPriorityToCalDav(priority: TaskPriority): number {
    switch (priority) {
      case 'CRITICAL':
      case 'HIGH':
        return 1;
      case 'MEDIUM':
        return 5;
      case 'LOW':
        return 9;
      default:
        return 5;
    }
  }

  /**
   * Escapes text values according to RFC 5545 (iCalendar).
   */
  private escapeIcsText(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /**
   * Builds a valid iCalendar VTODO payload with VALARM for Apple Reminders.
   */
  buildVTodoIcs(task: TaskRecord): string {
    const nowCompact = toCompactUtcString(new Date());
    const dueCompact = toCompactUtcString(task.due_at);
    const caldavStatus =
      task.status === 'COMPLETED'
        ? 'COMPLETED'
        : task.status === 'CANCELLED'
        ? 'CANCELLED'
        : 'NEEDS-ACTION';

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CFWorker Telegram Bot//VN',
      'BEGIN:VTODO',
      `UID:${task.id}`,
      `DTSTAMP:${nowCompact}`,
      `DUE:${dueCompact}`,
      `SUMMARY:${this.escapeIcsText(task.title)}`,
    ];

    if (task.description) {
      lines.push(`DESCRIPTION:${this.escapeIcsText(task.description)}`);
    }

    if (task.recurrence_rule) {
      lines.push(`RRULE:${task.recurrence_rule}`);
    }

    lines.push(`PRIORITY:${this.mapPriorityToCalDav(task.priority)}`);
    lines.push(`STATUS:${caldavStatus}`);

    if (task.status === 'COMPLETED') {
      lines.push(`COMPLETED:${nowCompact}`);
      lines.push('PERCENT-COMPLETE:100');
    }

    lines.push(
      'BEGIN:VALARM',
      'TRIGGER:-PT0M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'END:VALARM',
      'END:VTODO',
      'END:VCALENDAR'
    );

    return lines.join('\r\n') + '\r\n';
  }

  /**
   * Resolves decrypted CalDAV credentials for a user if configured.
   */
  async resolveUserConfig(user: UserRecord): Promise<CalDavConfig | null> {
    if (
      !user.icloud_apple_id ||
      !user.icloud_app_password_enc ||
      !user.icloud_calendar_url ||
      !this.encryptionSecretKey
    ) {
      return null;
    }

    try {
      const appSpecificPassword = await decryptText(
        user.icloud_app_password_enc,
        this.encryptionSecretKey
      );
      return {
        appleId: user.icloud_apple_id,
        appSpecificPassword,
        calendarUrl: user.icloud_calendar_url,
      };
    } catch (err) {
      console.error('Failed to decrypt user iCloud App-Specific Password:', err);
      return null;
    }
  }

  /**
   * Pushes or updates a VTODO item on Apple iCloud CalDAV server.
   */
  async syncTaskToICloud(task: TaskRecord, config: CalDavConfig): Promise<CalDavSyncResult> {
    const baseUrl = config.calendarUrl.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/${encodeURIComponent(task.id)}.ics`;
    const icsBody = this.buildVTodoIcs(task);
    const basicAuth = btoa(`${config.appleId}:${config.appSpecificPassword}`);

    const headers: Record<string, string> = {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'text/calendar; charset=utf-8',
    };

    if (task.caldav_etag) {
      headers['If-Match'] = task.caldav_etag;
    }

    try {
      const response = await fetch(targetUrl, {
        method: 'PUT',
        headers,
        body: icsBody,
        signal: AbortSignal.timeout(4000),
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          success: false,
          error: `CalDAV PUT failed (${response.status}): ${errText}`,
        };
      }

      const etag = response.headers.get('ETag') || response.headers.get('etag') || null;
      return {
        success: true,
        etag,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
