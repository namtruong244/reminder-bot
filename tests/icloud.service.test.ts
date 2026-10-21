import { describe, it, expect } from 'vitest';
import { ICloudService } from '../src/services/icloud.service';
import { TaskRecord } from '../src/types/task';

describe('ICloudService', () => {
  const service = new ICloudService();

  const sampleTask: TaskRecord = {
    id: '11111111-2222-3333-4444-555555555555',
    user_id: 12345678,
    title: 'Gửi hợp đồng cho khách',
    description: 'Hợp đồng dự án Cloudflare Workers',
    due_at: '2026-10-22T08:00:00.000Z',
    remind_at: '2026-10-22T07:45:00.000Z',
    priority: 'CRITICAL',
    status: 'PENDING',
    recurrence_rule: null,
    nagging_mode: 1,
    snooze_count: 0,
    ios_synced: 0,
  };

  it('generates valid VTODO iCalendar string matching Apple Reminders spec', () => {
    const ics = service.generateVTodoIcs(sampleTask, 'NEEDS-ACTION');

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('BEGIN:VTODO');
    expect(ics).toContain(`UID:${sampleTask.id}`);
    expect(ics).toContain('DUE:20261022T080000Z');
    expect(ics).toContain('SUMMARY:Gửi hợp đồng cho khách');
    expect(ics).toContain('DESCRIPTION:Hợp đồng dự án Cloudflare Workers');
    expect(ics).toContain('PRIORITY:1'); // CRITICAL maps to 1
    expect(ics).toContain('STATUS:NEEDS-ACTION');
    expect(ics).toContain('BEGIN:VALARM');
    expect(ics).toContain('TRIGGER:-PT0M');
    expect(ics).toContain('ACTION:DISPLAY');
    expect(ics).toContain('END:VALARM');
    expect(ics).toContain('END:VTODO');
    expect(ics).toContain('END:VCALENDAR');
  });

  it('generates completed status when task is finished', () => {
    const ics = service.generateVTodoIcs(sampleTask, 'COMPLETED');
    expect(ics).toContain('STATUS:COMPLETED');
    expect(ics).toContain('COMPLETED:');
  });
});
