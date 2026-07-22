import { describe, expect, it, vi } from 'vitest';

import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';
import { TASK_ALLOW_ACTION } from '../src/im/lark/task-action-card.js';

describe('card-handler task namespace dispatch', () => {
  it('routes task actions only through injected taskActionDeps', async () => {
    const calls: string[] = [];
    const deps = {
      activeSessions: new Map(),
      lastRepoScan: new Map(),
      sessionReply: vi.fn(),
      taskActionDeps: {
        isAuthorized: vi.fn(async (openId: string) => openId === 'ou_owner'),
        persist: vi.fn(async () => { calls.push('persist'); return {
          outcome: 'recorded' as const, effectiveAction: TASK_ALLOW_ACTION,
          triggerRequired: true as const, idempotencyKey: 'delivery.c17', dispatchToken: 'claim.c17',
        }; }),
        trigger: vi.fn(async () => { calls.push('trigger'); }),
      },
    } satisfies CardHandlerDeps;

    const result = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: TASK_ALLOW_ACTION, candidateId: 'candidate_17' } },
    }, deps, 'cli_app');

    expect(calls).toEqual(['persist', 'trigger']);
    expect(result).toEqual({ toast: { type: 'success', content: '已允许该任务，正在启动工作' } });
  });

  it('fails closed without configured task dependencies while other card routes remain available', async () => {
    const deps = {
      activeSessions: new Map(), lastRepoScan: new Map(), sessionReply: vi.fn(),
    } satisfies CardHandlerDeps;
    await expect(handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: TASK_ALLOW_ACTION, candidateId: 'candidate_17' } },
    }, deps, 'cli_app')).resolves.toEqual({
      toast: { type: 'error', content: '任务自动化未配置' },
    });
  });
});
