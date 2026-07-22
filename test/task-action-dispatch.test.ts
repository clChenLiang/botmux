import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  createTaskActionDispatch,
  type TaskCandidateRecord,
} from '../src/services/task-action-dispatch.js';
import {
  TASK_ALLOW_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
} from '../src/im/lark/task-action-card.js';
import type { TaskActionStartLedger } from '../src/services/task-action-start-ledger.js';

const ROOT = mkdtempSync(join(tmpdir(), 'botmux-task-repos-'));
mkdirSync(join(ROOT, 'marketplace/app'), { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
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
  const starts = new Map<string, { sessionId?: string; triggerId?: string } | 'starting'>();
  const startLedger: TaskActionStartLedger = {
    inspect(key) {
      const value = starts.get(key);
      return value === undefined ? { state: 'absent' }
        : value === 'starting' ? { state: 'uncertain' }
          : { state: 'started', ...value };
    },
    begin(key) {
      const existing = this.inspect(key);
      if (existing.state !== 'absent') return existing;
      starts.set(key, 'starting');
      return { state: 'acquired' };
    },
    complete(key, _token, receipt) { starts.set(key, receipt); },
    close() {},
  };
  const dispatch = createTaskActionDispatch({
    repoRoot: ROOT,
    repositories: { marketplace: 'marketplace/app' },
    resolveCandidate,
    start: async (request) => { await start(request); return {
      sessionId: 'session_started', triggerId: 'trigger_started',
    }; },
    startLedger,
    acknowledge,
  });
  return { calls, start, acknowledge, resolveCandidate, dispatch, startLedger, starts };
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
      workdir: join(realpathSync(ROOT), 'marketplace/app'),
      idempotencyKey: 'delivery.candidate_17',
      dispatchToken: 'claim.17',
      operatorOpenId: 'ou_owner',
    });
    expect(h.acknowledge).toHaveBeenCalledWith({
      idempotencyKey: 'delivery.candidate_17',
      dispatchToken: 'claim.17',
    });
  });

  it('keeps an uncertain durable fence when session start fails', async () => {
    const h = harness();
    h.start.mockRejectedValueOnce(new Error('start failed'));
    await expect(h.dispatch(claim())).rejects.toThrow('task action dispatch failed');
    expect(h.acknowledge).not.toHaveBeenCalled();
    await expect(h.dispatch(claim(TASK_ALLOW_ACTION, { dispatchToken: 'claim.retry' })))
      .rejects.toThrow(/outcome is uncertain/i);
    expect(h.start).toHaveBeenCalledOnce();
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

  it('acks a reclaimed token without starting again after the first ack failed', async () => {
    const h = harness();
    h.acknowledge.mockRejectedValueOnce(new Error('ack transport failed'));
    await expect(h.dispatch(claim())).rejects.toThrow('acknowledgement failed');
    await h.dispatch(claim(TASK_ALLOW_ACTION, { dispatchToken: 'claim.reclaimed' }));
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.acknowledge).toHaveBeenCalledTimes(2);
    expect(h.acknowledge).toHaveBeenLastCalledWith({
      idempotencyKey: 'delivery.candidate_17', dispatchToken: 'claim.reclaimed',
    });
  });

  it('fails closed without starting or acking when a previous process left a start intent', async () => {
    const h = harness();
    h.starts.set('delivery.candidate_17', 'starting');
    await expect(h.dispatch(claim())).rejects.toThrow(/outcome is uncertain/i);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it('uses the original session for completion feedback', async () => {
    const h = harness();
    await h.dispatch(claim(TASK_FEEDBACK_ACTION));
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'feedback', sessionId: 'session_original_17',
    }));
    expect(h.start.mock.calls[0][0]).not.toHaveProperty('workdir');
  });

  it('opens a Lark discussion fallback for an unknown allow without guessing a repo', async () => {
    const h = harness(null);
    await h.dispatch(claim(TASK_ALLOW_ACTION));
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: 'candidate_17', mode: 'discussion',
      prompt: expect.stringMatching(/候选详情.*仓库.*确认/),
    }));
    expect(h.start.mock.calls[0][0]).not.toHaveProperty('workdir');
    expect(h.start.mock.calls[0][0]).not.toHaveProperty('chatId');
    expect(h.acknowledge).toHaveBeenCalledOnce();
  });

  it.each([
    [{ marketplace: '../escape' }, 'parent traversal'],
    [{ marketplace: '/tmp/escape' }, 'absolute path'],
    [{ other: 'other' }, 'unknown mapping'],
    [{ marketplace: [] }, 'empty mapping'],
    [{ marketplace: ['marketplace', 'marketplace-v2'] }, 'ambiguous mapping'],
  ])('falls back to discussion for unsafe, missing, or ambiguous repository mappings (%s)', async (repositories) => {
    const start = vi.fn();
    const h = harness();
    const dispatch = createTaskActionDispatch({
      repoRoot: ROOT, repositories, resolveCandidate: async () => candidate,
      start: async (request) => { await start(request); return {}; },
      startLedger: h.startLedger,
      acknowledge: vi.fn(async () => ({ outcome: 'dispatched', idempotencyKey: 'delivery.candidate_17' })),
    });
    await dispatch(claim());
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: 'discussion' }));
    expect(start.mock.calls[0][0]).not.toHaveProperty('workdir');
  });

  it('falls back to discussion when a mapped repository is a symlink escape', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'botmux-task-outside-'));
    const link = join(ROOT, 'escaped-repository');
    symlinkSync(outside, link, 'dir');
    try {
      const h = harness();
      const dispatch = createTaskActionDispatch({
        repoRoot: ROOT, repositories: { marketplace: 'escaped-repository' },
        resolveCandidate: h.resolveCandidate, startLedger: h.startLedger,
        start: async (request) => { await h.start(request); return {}; },
        acknowledge: h.acknowledge,
      });
      await dispatch(claim());
      expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ mode: 'discussion' }));
      expect(h.start.mock.calls[0][0]).not.toHaveProperty('workdir');
    } finally {
      rmSync(link);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails closed when the mapped directory is replaced after planning but before start', async () => {
    const repository = join(ROOT, 'replaceable-repository');
    const moved = join(ROOT, 'replaceable-repository-original');
    const outside = mkdtempSync(join(tmpdir(), 'botmux-task-replaced-outside-'));
    mkdirSync(repository);
    const h = harness();
    const replacingLedger: TaskActionStartLedger = {
      ...h.startLedger,
      begin(key, token) {
        const result = h.startLedger.begin(key, token);
        rmSync(moved, { recursive: true, force: true });
        // Preserve the original inode elsewhere, then replace its path with an escape.
        // renameSync is required here so the planned dev/ino remains observable.
        renameSync(repository, moved);
        symlinkSync(outside, repository, 'dir');
        return result;
      },
    };
    const dispatch = createTaskActionDispatch({
      repoRoot: ROOT, repositories: { marketplace: 'replaceable-repository' },
      resolveCandidate: h.resolveCandidate, startLedger: replacingLedger,
      start: async (request) => { await h.start(request); return {}; },
      acknowledge: h.acknowledge,
    });
    try {
      await expect(dispatch(claim())).rejects.toThrow(/repository.*changed/i);
      expect(h.start).not.toHaveBeenCalled();
      expect(h.acknowledge).not.toHaveBeenCalled();
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
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

  it('falls feedback back to the original chat/root when its session is inactive', async () => {
    const h = harness();
    const dispatch = createTaskActionDispatch({
      repoRoot: ROOT,
      repositories: { marketplace: 'marketplace/app' },
      resolveCandidate: h.resolveCandidate,
      hasActiveSession: () => false,
      startLedger: h.startLedger,
      start: async (request) => { await h.start(request); return {}; },
      acknowledge: h.acknowledge,
    });
    await dispatch(claim(TASK_FEEDBACK_ACTION));
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'feedback', chatId: 'oc_tasks', rootMessageId: 'om_candidate_17',
    }));
    expect(h.start.mock.calls[0][0]).not.toHaveProperty('sessionId');
  });
});
