import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaskActionRecoveryLoop } from '../src/services/task-action-recovery-loop.js';
import { TASK_ALLOW_ACTION, TASK_DISCUSS_ACTION } from '../src/im/lark/task-action-card.js';

afterEach(() => vi.useRealTimers());

describe('task action recovery loop', () => {
  it('runs immediately, periodically below the lease, and stops cleanly', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const loop = createTaskActionRecoveryLoop({
      intervalMs: 60_000,
      leaseMs: 120_000,
      reconcile: vi.fn(async () => { calls.push('reconcile'); }),
      claim: vi.fn(async ({ leaseMs }) => {
        calls.push(`claim:${leaseMs}`);
        return [{
          action: TASK_ALLOW_ACTION, candidateId: 'candidate_17',
          idempotencyKey: `action:${'a'.repeat(64)}`, dispatchToken: 'claim.17',
          claimedAt: '2026-07-22T00:00:00.000Z', claimExpiresAt: '2026-07-22T00:02:00.000Z',
        }];
      }),
      dispatch: vi.fn(async () => { calls.push('dispatch'); }),
      log: vi.fn(),
    });

    await loop.start();
    expect(calls).toEqual(['reconcile', 'claim:120000', 'dispatch']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([
      'reconcile', 'claim:120000', 'dispatch',
      'reconcile', 'claim:120000', 'dispatch',
    ]);
    loop.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(6);
  });

  it('continues other claims and emits only redacted failure metadata', async () => {
    const log = vi.fn();
    const dispatch = vi.fn(async (request) => {
      if (request.candidateId === 'candidate_secret_1') throw new Error('PRIVATE TOKEN PATH');
    });
    const loop = createTaskActionRecoveryLoop({
      intervalMs: 60_000,
      leaseMs: 120_000,
      reconcile: vi.fn(async () => {}),
      claim: vi.fn(async () => [
        {
          action: TASK_ALLOW_ACTION, candidateId: 'candidate_secret_1',
          idempotencyKey: `action:${'a'.repeat(64)}`, dispatchToken: 'PRIVATE_TOKEN_1',
          claimedAt: '2026-07-22T00:00:00.000Z', claimExpiresAt: '2026-07-22T00:02:00.000Z',
        },
        {
          action: TASK_DISCUSS_ACTION, candidateId: 'candidate_secret_2',
          idempotencyKey: `action:${'b'.repeat(64)}`, dispatchToken: 'PRIVATE_TOKEN_2',
          claimedAt: '2026-07-22T00:00:00.000Z', claimExpiresAt: '2026-07-22T00:02:00.000Z',
        },
      ]),
      dispatch,
      log,
    });

    await loop.runNow();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|candidate_secret|action:[ab]/);
    loop.stop();
  });

  it('rejects an interval that is not strictly below the lease', () => {
    expect(() => createTaskActionRecoveryLoop({
      intervalMs: 60_000,
      leaseMs: 60_000,
      reconcile: vi.fn(), claim: vi.fn(), dispatch: vi.fn(), log: vi.fn(),
    })).toThrow(/interval/i);
  });
});
