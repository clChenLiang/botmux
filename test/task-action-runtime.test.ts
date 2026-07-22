import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTaskActionRuntime } from '../src/services/task-action-runtime.js';
import { TASK_ALLOW_ACTION } from '../src/im/lark/task-action-card.js';

describe('createTaskActionRuntime', () => {
  it('owner-gates by platform open_id and starts a trusted mapped turn before ack', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'botmux-task-runtime-'));
    mkdirSync(join(repoRoot, 'marketplace'));
    const calls: string[] = [];
    const runtime = createTaskActionRuntime({
      ownerOpenId: 'ou_owner',
      repoRoot,
      repositories: { marketplace: 'marketplace' },
      fallbackChatId: 'oc_tasks',
      hasActiveSession: () => false,
      startLedger: {
        inspect: () => ({ state: 'absent' as const }),
        begin: () => ({ state: 'acquired' as const }),
        complete: vi.fn(), close: vi.fn(),
      },
      resolveCandidate: async () => ({
        candidateId: 'candidate_17', repositoryId: 'marketplace', chatId: 'oc_tasks',
        rootMessageId: 'om_17', prompt: 'Implement it', sourceRef: 'lark://doc/17',
      }),
      persist: vi.fn(async () => ({
        outcome: 'recorded' as const, effectiveAction: TASK_ALLOW_ACTION,
        triggerRequired: true as const, idempotencyKey: 'delivery.17', dispatchToken: 'claim.17',
      })),
      acknowledge: vi.fn(async () => { calls.push('ack'); return {
        outcome: 'dispatched' as const, idempotencyKey: 'delivery.17',
      }; }),
      startTurn: vi.fn(async (request) => { calls.push('start'); expect(request).toMatchObject({
        chatId: 'oc_tasks', rootMessageId: 'om_17', workingDir: join(realpathSync(repoRoot), 'marketplace'),
        instruction: 'Implement it', dedupKey: 'delivery.17', dispatchToken: 'claim.17',
      }); }),
    });
    await expect(runtime.handlerDeps.isAuthorized('ou_owner')).resolves.toBe(true);
    await expect(runtime.handlerDeps.isAuthorized('ou_attacker')).resolves.toBe(false);
    await runtime.handlerDeps.trigger({
      action: TASK_ALLOW_ACTION, candidateId: 'candidate_17', mode: 'work',
      operatorOpenId: 'ou_owner', idempotencyKey: 'delivery.17', dispatchToken: 'claim.17',
    });
    expect(calls).toEqual(['start', 'ack']);
    rmSync(repoRoot, { recursive: true, force: true });
  });
});
