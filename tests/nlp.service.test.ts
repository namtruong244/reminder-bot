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
});
