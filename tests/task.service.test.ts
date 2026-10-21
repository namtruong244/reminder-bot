import { describe, it, expect, vi } from 'vitest';
import { TaskService } from '../src/services/task.service';
import { TaskRecord, UserRecord } from '../src/types/task';

describe('TaskService', () => {
  it('upserts and retrieves user', async () => {
    const mockUser: UserRecord = {
      telegram_id: 123456,
      username: 'testuser',
      timezone: 'Asia/Ho_Chi_Minh',
      created_at: new Date().toISOString(),
    };

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(mockUser),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      }),
    } as unknown as D1Database; // Mock D1 for unit testing

    const taskService = new TaskService(mockDb);
    const user = await taskService.upsertUser({
      telegram_id: 123456,
      username: 'testuser',
    });

    expect(user.telegram_id).toBe(123456);
    expect(user.username).toBe('testuser');
  });

  it('creates a task record', async () => {
    const sampleTask: TaskRecord = {
      id: 'task-uuid-1234',
      user_id: 123456,
      title: 'Họp công ty',
      due_at: '2026-10-21T10:00:00.000Z',
      remind_at: '2026-10-21T09:45:00.000Z',
      priority: 'HIGH',
      status: 'PENDING',
      recurrence_rule: null,
      nagging_mode: 0,
      snooze_count: 0,
      ios_synced: 0,
    };

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleTask),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      }),
    } as unknown as D1Database; // Mock D1 for unit testing

    const taskService = new TaskService(mockDb);
    const created = await taskService.createTask(sampleTask);

    expect(created.id).toBe(sampleTask.id);
    expect(created.title).toBe('Họp công ty');
    expect(created.priority).toBe('HIGH');
  });

  it('batches update statements properly', async () => {
    const batchMock = vi.fn().mockResolvedValue([]);
    const prepareMock = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({}),
    });

    const mockDb = {
      prepare: prepareMock,
      batch: batchMock,
    } as unknown as D1Database; // Mock D1 for unit testing

    const taskService = new TaskService(mockDb);
    await taskService.batchUpdateRemindAt([
      { id: '1', remind_at: '2026-10-21T12:00:00Z', last_notified_at: '2026-10-21T11:50:00Z' },
      { id: '2', remind_at: '2026-10-21T13:00:00Z' },
    ]);

    expect(prepareMock).toHaveBeenCalledTimes(2);
    expect(batchMock).toHaveBeenCalledTimes(1);
  });
});
