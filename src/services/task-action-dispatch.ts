import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  TASK_ALLOW_ACTION,
  TASK_FEEDBACK_ACTION,
} from '../im/lark/task-action-card.js';
import type { TaskActionTriggerRequest } from '../im/lark/task-action-card-handler.js';
import type {
  TaskActionDispatchAcknowledgementRequest,
  TaskActionDispatchAcknowledgementResult,
} from './task-action-sink.js';
import type {
  TaskActionStartLedger,
  TaskActionStartReceipt,
} from './task-action-start-ledger.js';

export interface TaskCandidateRecord {
  candidateId: string;
  repositoryId: string;
  chatId: string;
  rootMessageId?: string;
  prompt: string;
  sourceRef: string;
  originalSessionId?: string;
}

export interface TaskActionStartRequest {
  candidateId: string;
  chatId?: string;
  rootMessageId?: string;
  sessionId?: string;
  prompt: string;
  sourceRef?: string;
  mode: 'work' | 'discussion' | 'feedback';
  workdir?: string;
  operatorOpenId: string;
  idempotencyKey: string;
  dispatchToken: string;
  /** Re-check immediately before the side effect to close path replacement races. */
  verifyWorkdir?: () => void;
}

export interface TaskActionDispatchDeps {
  repoRoot: string;
  repositories: Readonly<Record<string, string | readonly string[]>>;
  resolveCandidate: (candidateId: string) => TaskCandidateRecord | undefined
    | Promise<TaskCandidateRecord | undefined>;
  start: (request: TaskActionStartRequest, verifyWorkdir?: () => void) => TaskActionStartReceipt
    | Promise<TaskActionStartReceipt>;
  startLedger: TaskActionStartLedger;
  hasActiveSession?: (sessionId: string) => boolean | Promise<boolean>;
  acknowledge: (
    request: TaskActionDispatchAcknowledgementRequest,
  ) => TaskActionDispatchAcknowledgementResult | Promise<TaskActionDispatchAcknowledgementResult>;
}

export class TaskActionDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskActionDispatchError';
  }
}

/**
 * Build the durable claim dispatcher. The stable idempotency key is also the
 * in-process coalescing key; Task OS remains the cross-process authority.
 */
export function createTaskActionDispatch(
  deps: TaskActionDispatchDeps,
): (request: TaskActionTriggerRequest) => Promise<void> {
  const repoRoot = canonicalRoot(deps.repoRoot);
  const inFlight = new Map<string, Promise<void>>();

  return async (request) => {
    const running = inFlight.get(request.idempotencyKey);
    if (running) return running;
    const task = dispatchOne(request, deps, repoRoot).finally(() => {
      if (inFlight.get(request.idempotencyKey) === task) inFlight.delete(request.idempotencyKey);
    });
    inFlight.set(request.idempotencyKey, task);
    return task;
  };
}

async function dispatchOne(
  request: TaskActionTriggerRequest,
  deps: TaskActionDispatchDeps,
  repoRoot: DirectoryIdentity,
): Promise<void> {
  const previous = deps.startLedger.inspect(request.idempotencyKey);
  if (previous.state === 'started') {
    await acknowledge(request, deps);
    return;
  }
  if (previous.state === 'uncertain') {
    throw new TaskActionDispatchError('task action start outcome is uncertain');
  }

  let candidate: TaskCandidateRecord | undefined;
  try {
    candidate = await deps.resolveCandidate(request.candidateId);
  } catch {
    throw new TaskActionDispatchError('task candidate resolution failed');
  }

  let start: TaskActionStartRequest;
  if (!candidate) {
    start = {
      candidateId: request.candidateId,
      prompt: `候选详情暂不可用，且仓库无法确认。请讨论并确认任务 ${request.candidateId} 的目标仓库后再开始。`,
      mode: 'discussion',
      operatorOpenId: request.operatorOpenId,
      idempotencyKey: request.idempotencyKey,
      dispatchToken: request.dispatchToken,
    };
  } else {
    validateCandidate(candidate, request.candidateId);
    const common = {
      candidateId: candidate.candidateId,
      chatId: candidate.chatId,
      rootMessageId: candidate.rootMessageId,
      prompt: candidate.prompt,
      sourceRef: candidate.sourceRef,
      operatorOpenId: request.operatorOpenId,
      idempotencyKey: request.idempotencyKey,
      dispatchToken: request.dispatchToken,
    };
    if (request.action === TASK_ALLOW_ACTION) {
      const workdir = mappedWorkdir(repoRoot, deps.repositories, candidate.repositoryId);
      start = workdir
        ? {
            ...common,
            mode: 'work',
            workdir: workdir.path,
            verifyWorkdir: () => verifyWorkdir(workdir),
            sessionId: undefined,
          }
        : {
            candidateId: candidate.candidateId,
            prompt: `仓库映射缺失或不唯一。请讨论并确认任务 ${candidate.candidateId} 的目标仓库后再开始。`,
            mode: 'discussion',
            operatorOpenId: request.operatorOpenId,
            idempotencyKey: request.idempotencyKey,
            dispatchToken: request.dispatchToken,
          };
    } else if (request.action === TASK_FEEDBACK_ACTION) {
      const active = candidate.originalSessionId
        ? await deps.hasActiveSession?.(candidate.originalSessionId) ?? true
        : false;
      start = active
        ? { ...common, mode: 'feedback', sessionId: candidate.originalSessionId }
        : { ...common, mode: 'feedback' };
    } else {
      start = { ...common, mode: 'discussion' };
    }
  }

  const claim = deps.startLedger.begin(request.idempotencyKey, request.dispatchToken);
  if (claim.state === 'started') {
    await acknowledge(request, deps);
    return;
  }
  if (claim.state !== 'acquired') {
    throw new TaskActionDispatchError('task action start outcome is uncertain');
  }

  const { verifyWorkdir: verify, ...startRequest } = start;
  verify?.();
  let receipt: TaskActionStartReceipt;
  try {
    receipt = await deps.start(startRequest, verify);
  } catch {
    throw new TaskActionDispatchError('task action dispatch failed');
  }
  try {
    deps.startLedger.complete(request.idempotencyKey, request.dispatchToken, receipt);
  } catch {
    throw new TaskActionDispatchError('task action start recording failed');
  }
  await acknowledge(request, deps);
}

async function acknowledge(
  request: TaskActionTriggerRequest,
  deps: TaskActionDispatchDeps,
): Promise<void> {
  try {
    await deps.acknowledge({
      idempotencyKey: request.idempotencyKey,
      dispatchToken: request.dispatchToken,
    });
  } catch {
    throw new TaskActionDispatchError('task action acknowledgement failed');
  }
}

type DirectoryIdentity = {
  path: string;
  realPath: string;
  device: number | bigint;
  inode: number | bigint;
};

type WorkdirIdentity = DirectoryIdentity & { root: DirectoryIdentity };

function canonicalRoot(value: string): DirectoryIdentity {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TaskActionDispatchError('invalid repository root');
  }
  try {
    const path = resolve(value);
    const realPath = realpathSync(path);
    const stat = lstatSync(realPath, { bigint: true });
    if (!stat.isDirectory()) throw new Error('not directory');
    return { path, realPath, device: stat.dev, inode: stat.ino };
  } catch {
    throw new TaskActionDispatchError('invalid repository root');
  }
}

function mappedWorkdir(
  repoRoot: DirectoryIdentity,
  repositories: Readonly<Record<string, string | readonly string[]>>,
  repositoryId: string,
): WorkdirIdentity | undefined {
  const mapping = repositories[repositoryId];
  const configured = Array.isArray(mapping) ? (mapping.length === 1 ? mapping[0] : undefined) : mapping;
  if (typeof configured !== 'string' || configured.length === 0 || isAbsolute(configured)) return undefined;
  const workdir = resolve(repoRoot.realPath, configured);
  const child = relative(repoRoot.realPath, workdir);
  if (!child || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) {
    return undefined;
  }
  try {
    assertNoSymlinkSegments(repoRoot.realPath, child);
    const realPath = realpathSync(workdir);
    if (!isConfined(repoRoot.realPath, realPath)) return undefined;
    const stat = lstatSync(realPath, { bigint: true });
    if (!stat.isDirectory()) return undefined;
    return { path: workdir, realPath, device: stat.dev, inode: stat.ino, root: repoRoot };
  } catch {
    return undefined;
  }
}

function verifyWorkdir(identity: WorkdirIdentity): void {
  try {
    const rootStat = lstatSync(realpathSync(identity.root.path), { bigint: true });
    if (rootStat.dev !== identity.root.device || rootStat.ino !== identity.root.inode) throw new Error();
    const child = relative(identity.root.realPath, identity.path);
    assertNoSymlinkSegments(identity.root.realPath, child);
    const realPath = realpathSync(identity.path);
    const stat = lstatSync(realPath, { bigint: true });
    if (realPath !== identity.realPath
      || stat.dev !== identity.device
      || stat.ino !== identity.inode
      || !stat.isDirectory()
      || !isConfined(identity.root.realPath, realPath)) throw new Error();
  } catch {
    throw new TaskActionDispatchError('repository path changed before start');
  }
}

function assertNoSymlinkSegments(root: string, child: string): void {
  let current = root;
  for (const segment of child.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error('symlink repository path');
  }
}

function isConfined(root: string, child: string): boolean {
  const rel = relative(root, child);
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validateCandidate(candidate: TaskCandidateRecord, expectedId: string): void {
  if (candidate.candidateId !== expectedId
    || !candidate.repositoryId
    || !candidate.chatId
    || !candidate.prompt
    || !candidate.sourceRef) {
    throw new TaskActionDispatchError('invalid task candidate');
  }
}
