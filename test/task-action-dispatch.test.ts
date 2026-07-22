import { describe, expect, it, vi } from 'vitest';

import {
  createTaskActionDispatch,
  type TaskCandidateRecord,
} from '../src/services/task-action-dispatch.js';
import {
  TASK_ALLOW_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
} from '../src/im/lark/task-action-card.js';

const ROOT = '/srv/code';
const candidate: TaskCandidateRecord = {
  candidateId: 'candidate_17',
  repositoryId: 'marketplace',
  chatId: 'oc_tasks',
  rootMessageId: 'om_candidate_17',
  prompt: 'Implement the accepted task',
  sourceRef: 'lark://doc/source_17',
  originalSessionId: 'session_original_17',
};

function harness(record: TaskCandidateRecord | null = candidate) {
  const calls: string[] = [];
  const start = vi.fn(async () => { calls.push('start'); });
  const acknowledge = vi.fn(async () => { calls.push('ack'); return { outcome: 'dispatched' as const, idempotencyKey: 'delivery.candidate_17' }; });
  const resolveCandidate = vi.fn(async () => { calls.push('resolve'); return record ?? undefined; });
  const dispatch = createTaskActionDispatch({
    repoRoot: ROOT,
    repositories: { marketplace: 'marketplace/app' },
    resolveCandidate,
    start,
    acknowledge,
  });
  return { calls, start, acknowledge, resolveCandidate, dispatch };
}

const claim = (action = TASK_ALLOW_ACTION, overrides: Record<string, unknown> = {}) => ({
  action,
  candidateId: 'candidate_17',
  mode: action === TASK_ALLOW_ACTION ? 'work' : action === TASK_DISCUSS_ACTION ? 'discussion' : 'feedback',
  operatorOpenId: 'ou_owner',
  idempotencyKey: 'delivery.candidate_17',
  dispatchToken: 'claim.17',
  ...overrides,
} as any);

describe('createTaskActionDispatch', () => {
  it('resolves authoritative state, starts the mapped workdir, then fenced-acks', async () => {
    const h = harness();
    await h.dispatch(claim());
    expect(h.calls).toEqual(['resolve', 'start', 'ack']);
    expect(h.start).toHaveBeenCalledWith({
      candidateId: candidate.candidateId,
      chatId: candidate.chatId,
      rootMessageId: candidate.rootMessageId,
      sessionId: undefined,
      prompt: candidate.prompt,
      sourceRef: candidate.sourceRef,
      mode: 'work',
      workdir: '/srv/code/marketplace/app',
      idempotencyKey: 'delivery.candidate_17',
      dispatchToken: 'claim.17',
      operatorOpenId: 'ou_owner',
    });
    expect(h.acknowledge).toHaveBeenCalledWith({
      idempotencyKey: 'delivery.candidate_17',
      dispatchToken: 'claim.17',
    });
  });

  it('does not ack when the session start fails so Task OS can reclaim it', async () => {
    const h = harness();
    h.start.mockRejectedValueOnce(new Error('start failed'));
    await expect(h.dispatch(claim())).rejects.toThrow('task action dispatch failed');
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it('surfaces ack failure after a successful start and keeps the stable dedup key', async () => {
    const h = harness();
    h.acknowledge.mockRejectedValueOnce(new Error('stale token'));
    await expect(h.dispatch(claim())).rejects.toThrow('task action acknowledgement failed');
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.start.mock.calls[0][0]).toMatchObject({
      idempotencyKey: 'delivery.candidate_17', dispatchToken: 'claim.17',
    });
  });

  it('uses the original session for completion feedback', async () => {
    const h = harness();
    await h.dispatch(claim(TASK_FEEDBACK_ACTION));
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'feedback', sessionId: 'session_original_17',
    }));
    expect(h.start.mock.calls[0][0]).not.toHaveProperty('workdir');
  });

  it('opens a Lark discussion fallback for an unknown candidate without guessing a repo', async () => {
    const h = harness(null);
    await h.dispatch(claim(TASK_DISCUSS_ACTION));
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: 'candidate_17', mode: 'discussion',
      prompt: '讨论候选任务 candidate_17（候选详情暂不可用）',
    }));
    expect(h.start.mock.calls[0][0]).not.toHaveProperty('workdir');
    expect(h.acknowledge).toHaveBeenCalledOnce();
  });

  it('fails closed for unknown work candidates and never acknowledges them', async () => {
    const h = harness(null);
    await expect(h.dispatch(claim())).rejects.toThrow('unknown task candidate');
    expect(h.start).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it.each([
    [{ marketplace: '../escape' }, 'parent traversal'],
    [{ marketplace: '/tmp/escape' }, 'absolute path'],
    [{ other: 'other' }, 'unknown mapping'],
  ])('rejects non-canonical or missing repository mappings (%s)', async (repositories) => {
    const start = vi.fn();
    const dispatch = createTaskActionDispatch({
      repoRoot: ROOT, repositories, resolveCandidate: async () => candidate,
      start, acknowledge: vi.fn(),
    });
    await expect(dispatch(claim())).rejects.toThrow('repository mapping unavailable');
    expect(start).not.toHaveBeenCalled();
  });

  it('deduplicates simultaneous claims by stable key while preserving fencing token', async () => {
    const h = harness();
    let release!: () => void;
    h.start.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = h.dispatch(claim());
    const duplicate = h.dispatch(claim(TASK_ALLOW_ACTION, { dispatchToken: 'claim.18' }));
    await Promise.resolve();
    release();
    await Promise.all([first, duplicate]);
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.acknowledge).toHaveBeenCalledOnce();
  });

  it('replays recovered Task OS claims through the same fenced dispatch path', async () => {
    const h = harness();
    await h.dispatch({
      action: TASK_DISCUSS_ACTION,
      candidateId: 'candidate_17',
      mode: 'discussion',
      operatorOpenId: 'ou_owner',
      idempotencyKey: 'delivery.candidate_17',
      dispatchToken: 'claim.recovered',
    });
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'discussion', dispatchToken: 'claim.recovered',
    }));
    expect(h.acknowledge).toHaveBeenCalledWith({
      idempotencyKey: 'delivery.candidate_17', dispatchToken: 'claim.recovered',
    });
  });
});
