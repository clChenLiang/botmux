import { describe, expect, it, vi } from 'vitest';

import {
  handleTaskActionCard,
  type TaskActionHandlerDeps,
  type TaskActionPersistenceRequest,
  type TaskActionTriggerRequest,
} from '../src/im/lark/task-action-card-handler.js';
import {
  MR_IGNORE_ACTION,
  MR_KEEP_WATCHING_ACTION,
  REPOSITORY_IGNORE_ACTION,
  TASK_ALLOW_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
  TASK_REJECT_ACTION,
} from '../src/im/lark/task-action-card.js';

const OWNER = 'ou_owner';
const CANDIDATE_ID = 'candidate_01JZ8N9QG5';

function callback(action: string, idKey = 'candidateId', id = CANDIDATE_ID, operator = OWNER): unknown {
  return {
    operator: { open_id: operator },
    action: { value: { action, [idKey]: id } },
  };
}

function harness(overrides: Partial<TaskActionHandlerDeps> = {}) {
  const calls: string[] = [];
  const persist = vi.fn(async (_request: TaskActionPersistenceRequest) => {
    calls.push('persist');
    return { outcome: 'recorded' as const };
  });
  const trigger = vi.fn(async (_request: TaskActionTriggerRequest) => {
    calls.push('trigger');
  });
  const isAuthorized = vi.fn(async (openId: string) => openId === OWNER);
  return {
    calls,
    persist,
    trigger,
    isAuthorized,
    deps: { persist, trigger, isAuthorized, ...overrides } satisfies TaskActionHandlerDeps,
  };
}

describe('handleTaskActionCard', () => {
  it.each([
    [TASK_ALLOW_ACTION, 'work'],
    [TASK_DISCUSS_ACTION, 'discussion'],
    [TASK_FEEDBACK_ACTION, 'feedback'],
  ] as const)('persists %s before starting its mapped trigger', async (action, mode) => {
    const h = harness();

    const result = await handleTaskActionCard(callback(action), h.deps);

    expect(h.calls).toEqual(['persist', 'trigger']);
    expect(h.persist).toHaveBeenCalledWith({
      action,
      subject: { type: 'candidate', id: CANDIDATE_ID },
      operatorOpenId: OWNER,
    });
    expect(h.trigger).toHaveBeenCalledWith({
      action,
      candidateId: CANDIDATE_ID,
      mode,
      operatorOpenId: OWNER,
    });
    expect(result).toEqual({ toast: { type: 'success', content: expect.any(String) } });
  });

  it('persists a rejection without starting work', async () => {
    const h = harness();
    const result = await handleTaskActionCard(callback(TASK_REJECT_ACTION), h.deps);
    expect(h.persist).toHaveBeenCalledOnce();
    expect(h.trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ toast: { type: 'success', content: '已拒绝该任务' } });
  });

  it.each([
    [MR_IGNORE_ACTION, 'mrId', 'mr_23817', 'mr'],
    [REPOSITORY_IGNORE_ACTION, 'repositoryId', 'repo_marketplace', 'repository'],
  ] as const)('persists %s only and never starts work', async (action, idKey, id, type) => {
    const h = harness();
    const result = await handleTaskActionCard(callback(action, idKey, id), h.deps);
    expect(h.persist).toHaveBeenCalledWith({
      action,
      subject: { type, id },
      operatorOpenId: OWNER,
    });
    expect(h.trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ toast: { type: 'success', content: expect.any(String) } });
  });

  it('keeps watching without mutating durable state or starting work', async () => {
    const h = harness();
    const result = await handleTaskActionCard(callback(MR_KEEP_WATCHING_ACTION, 'mrId', 'mr_23817'), h.deps);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ toast: { type: 'info', content: '将继续关注此 MR' } });
  });

  it('maps a same-action sink duplicate to an idempotent response without retriggering', async () => {
    const h = harness({
      persist: vi.fn(async () => ({ outcome: 'duplicate', effectiveAction: TASK_ALLOW_ACTION })),
    });
    const result = await handleTaskActionCard(callback(TASK_ALLOW_ACTION), h.deps);
    expect(h.trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ toast: { type: 'info', content: '该操作已处理，无需重复提交' } });
  });

  it('maps a losing concurrent decision to the first decision without retriggering', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let winner = false;
    const persist = vi.fn(async (request: TaskActionPersistenceRequest) => {
      await gate;
      if (!winner) {
        winner = true;
        return { outcome: 'recorded' as const };
      }
      return { outcome: 'conflict' as const, effectiveAction: TASK_ALLOW_ACTION };
    });
    const h = harness({ persist });

    const allow = handleTaskActionCard(callback(TASK_ALLOW_ACTION), h.deps);
    const reject = handleTaskActionCard(callback(TASK_REJECT_ACTION), h.deps);
    release();
    const [allowResult, rejectResult] = await Promise.all([allow, reject]);

    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(allowResult).toEqual({ toast: { type: 'success', content: expect.any(String) } });
    expect(rejectResult).toEqual({
      toast: { type: 'warning', content: '任务已按「允许」处理，本次操作未生效' },
    });
  });

  it('uses only platform operator.open_id for authorization and persistence', async () => {
    const h = harness();
    const spoofed = callback(TASK_ALLOW_ACTION) as any;
    spoofed.action.value.open_id = OWNER;
    spoofed.operator.open_id = 'ou_attacker';
    const result = await handleTaskActionCard(spoofed, h.deps);
    expect(h.isAuthorized).toHaveBeenCalledWith('ou_attacker');
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ toast: { type: 'warning', content: '你没有权限执行此操作' } });
  });

  it.each([
    undefined,
    null,
    {},
    { action: { value: { action: TASK_ALLOW_ACTION, candidateId: CANDIDATE_ID } } },
    { operator: { open_id: OWNER }, action: { value: { action: 'unknown', candidateId: CANDIDATE_ID } } },
    { operator: { open_id: OWNER }, action: { value: { action: TASK_ALLOW_ACTION } } },
    { operator: { open_id: OWNER }, action: { value: { action: TASK_ALLOW_ACTION, candidateId: '../repo' } } },
    { operator: { open_id: OWNER }, action: { value: { action: TASK_ALLOW_ACTION, candidateId: 42 } } },
  ])('fails closed for malformed or unknown callback %#', async (data) => {
    const h = harness();
    const result = await handleTaskActionCard(data, h.deps);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ toast: { type: 'warning', content: '操作无效或已失效' } });
  });

  it.each([
    Object.defineProperty({}, 'operator', { get() { throw new Error('SECRET getter'); } }),
    new Proxy({}, { ownKeys() { throw new Error('SECRET proxy'); } }),
    { operator: { open_id: OWNER }, action: Object.defineProperty({}, 'value', { get() { throw new Error('SECRET nested'); } }) },
  ])('contains hostile getters and proxies without leaking errors', async (data) => {
    const h = harness();
    await expect(handleTaskActionCard(data, h.deps)).resolves.toEqual({
      toast: { type: 'warning', content: '操作无效或已失效' },
    });
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it('fails closed when authorization throws and redacts its error', async () => {
    const h = harness({ isAuthorized: vi.fn(async () => { throw new Error('SECRET auth'); }) });
    const result = await handleTaskActionCard(callback(TASK_ALLOW_ACTION), h.deps);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ toast: { type: 'warning', content: '你没有权限执行此操作' } });
  });

  it('fails closed and redacts durable sink errors', async () => {
    const h = harness({ persist: vi.fn(async () => { throw new Error('SECRET state path'); }) });
    const result = await handleTaskActionCard(callback(TASK_ALLOW_ACTION), h.deps);
    expect(h.trigger).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result).toEqual({ toast: { type: 'error', content: '操作保存失败，请稍后重试' } });
  });

  it('reports a redacted trigger failure after durable persistence', async () => {
    const h = harness({ trigger: vi.fn(async () => { throw new Error('SECRET repo path'); }) });
    const result = await handleTaskActionCard(callback(TASK_ALLOW_ACTION), h.deps);
    expect(h.persist).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result).toEqual({ toast: { type: 'warning', content: '操作已保存，自动启动暂时失败' } });
  });

  it('fails closed for malformed sink outcomes', async () => {
    const h = harness({ persist: vi.fn(async () => ({ outcome: 'duplicate' } as any)) });
    const result = await handleTaskActionCard(callback(TASK_ALLOW_ACTION), h.deps);
    expect(h.trigger).not.toHaveBeenCalled();
    expect(result).toEqual({ toast: { type: 'error', content: '操作保存失败，请稍后重试' } });
  });

  it('contains hostile sink outcomes without leaking their errors', async () => {
    const hostile = Object.defineProperty({}, 'outcome', {
      get() { throw new Error('SECRET sink getter'); },
    });
    const h = harness({ persist: vi.fn(async () => hostile as any) });
    const operation = handleTaskActionCard(callback(TASK_ALLOW_ACTION), h.deps);
    await expect(operation).resolves.toEqual({
      toast: { type: 'error', content: '操作保存失败，请稍后重试' },
    });
    expect(h.trigger).not.toHaveBeenCalled();
  });
});
