import { describe, it, expect } from 'vitest';
import { NlpService } from '../src/services/nlp.service';

describe('NlpService', () => {
  const service = new NlpService(); // Fallback heuristic mode

  it('detects list tasks intent', async () => {
    const result = await service.parseUserPrompt('Xem danh sách công việc của tôi');
    expect(result.intent).toBe('LIST_TASKS');
  });

  it('extracts task with minutes delay and critical priority heuristic', async () => {
    const result = await service.parseUserPrompt('Nhắc tôi gọi điện cho sếp sau 15 phút, việc gấp');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.priority).toBe('CRITICAL');
    expect(result.nagging_mode).toBe(true);
    expect(result.due_at_iso).toBeDefined();
    expect(result.title).toContain('gọi điện cho sếp');
  });

  it('extracts task with hours delay', async () => {
    const result = await service.parseUserPrompt('Nhắc tôi nộp báo cáo sau 2 tiếng');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.priority).toBe('MEDIUM');
    expect(result.due_at_iso).toBeDefined();
  });

  it('extracts "Uống nước 10p nữa" correctly', async () => {
    const result = await service.parseUserPrompt('Uống nước 10p nữa');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toContain('Uống nước');
    expect(result.remind_before_minutes).toBe(0);
    expect(result.due_at_iso).toBeDefined();
  });

  it('extracts "4 rưỡi chiều nay" correctly', async () => {
    const result = await service.parseUserPrompt('Nhắc sau 4 rưỡi chiều nay nộp báo cáo');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toContain('nộp báo cáo');
    expect(result.due_at_iso).toContain('T16:30:00+07:00');
  });

  // ========== TEST CASES FOR REPORTED ISSUES ==========

  it('extracts "trưa mai làm..." correctly', async () => {
    const result = await service.parseUserPrompt('trưa mai làm báo cáo tài chính');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('làm báo cáo tài chính');
    expect(result.due_at_iso).toBeDefined();
    expect(result.due_at_iso).toContain('T12:00:00+07:00');
    expect(result.remind_before_minutes).toBe(0);

    // Verify it is tomorrow's date
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const expectedYear = tomorrow.getFullYear();
    expect(result.due_at_iso).toContain(`${expectedYear}-`);
  });

  it('extracts "thanh toán tiền điện ngày 4 hàng tháng" correctly', async () => {
    const result = await service.parseUserPrompt('thanh toán tiền điện ngày 4 hàng tháng');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('thanh toán tiền điện');
    expect(result.recurrence_rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=4');
    expect(result.due_at_iso).toBeDefined();
    expect(result.due_at_iso).toContain('-04T09:00:00+07:00');

    // Ensure due_at_iso is in the future
    const dueDate = new Date(result.due_at_iso!);
    expect(dueDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('extracts "4h45 chiều mai nộp báo cáo" capturing full minutes', async () => {
    const result = await service.parseUserPrompt('4h45 chiều mai nộp báo cáo');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('nộp báo cáo');
    expect(result.due_at_iso).toContain('T16:45:00+07:00');
  });

  it('does not falsely set minute to 30 when message contains number 30 elsewhere', async () => {
    const result = await service.parseUserPrompt('Nhắc tôi 2h chiều gửi 30 bản hợp đồng');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.due_at_iso).toContain('T14:00:00+07:00');
    expect(result.title).toContain('30 bản hợp đồng');
  });

  it('extracts "sáng mốt đi khám bệnh" (+2 days) correctly', async () => {
    const result = await service.parseUserPrompt('sáng mốt đi khám bệnh');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('đi khám bệnh');
    expect(result.due_at_iso).toContain('T08:00:00+07:00');
  });

  it('extracts "mỗi ngày 8h sáng uống thuốc" correctly', async () => {
    const result = await service.parseUserPrompt('mỗi ngày 8h sáng uống thuốc');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('uống thuốc');
    expect(result.recurrence_rrule).toBe('FREQ=DAILY');
    expect(result.due_at_iso).toContain('T08:00:00+07:00');
  });

  it('extracts "thứ 2 hàng tuần họp giao ban" correctly', async () => {
    const result = await service.parseUserPrompt('thứ 2 hàng tuần họp giao ban');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toBe('họp giao ban');
    expect(result.recurrence_rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(result.due_at_iso).toContain('T09:00:00+07:00');
  });
});
