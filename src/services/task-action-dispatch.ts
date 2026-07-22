import { isAbsolute, relative, resolve } from 'node:path';

import {
  TASK_ALLOW_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
} from '../im/lark/task-action-card.js';
import type { TaskActionTriggerRequest } from '../im/lark/task-action-card-handler.js';
import type {
  TaskActionDispatchAcknowledgementRequest,
  TaskActionDispatchAcknowledgementResult,
} from './task-action-sink.js';

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
}

export interface TaskActionDispatchDeps {
  repoRoot: string;
  repositories: Readonly<Record<string, string>>;
  resolveCandidate: (candidateId: string) => TaskCandidateRecord | undefined
    | Promise<TaskCandidateRecord | undefined>;
  start: (request: TaskActionStartRequest) => void | Promise<void>;
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
  repoRoot: string,
): Promise<void> {
  let candidate: TaskCandidateRecord | undefined;
  try {
    candidate = await deps.resolveCandidate(request.candidateId);
  } catch {
    throw new TaskActionDispatchError('task candidate resolution failed');
  }

  let start: TaskActionStartRequest;
  if (!candidate) {
    if (request.action !== TASK_DISCUSS_ACTION) {
      throw new TaskActionDispatchError('unknown task candidate');
    }
    start = {
      candidateId: request.candidateId,
      prompt: `讨论候选任务 ${request.candidateId}（候选详情暂不可用）`,
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
      if (!workdir) throw new TaskActionDispatchError('repository mapping unavailable');
      start = { ...common, mode: 'work', workdir, sessionId: undefined };
    } else if (request.action === TASK_FEEDBACK_ACTION) {
      if (!candidate.originalSessionId) {
        throw new TaskActionDispatchError('original task session unavailable');
      }
      start = { ...common, mode: 'feedback', sessionId: candidate.originalSessionId };
    } else {
      start = { ...common, mode: 'discussion' };
    }
  }

  try {
    await deps.start(start);
  } catch {
    throw new TaskActionDispatchError('task action dispatch failed');
  }
  try {
    await deps.acknowledge({
      idempotencyKey: request.idempotencyKey,
      dispatchToken: request.dispatchToken,
    });
  } catch {
    throw new TaskActionDispatchError('task action acknowledgement failed');
  }
}

function canonicalRoot(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TaskActionDispatchError('invalid repository root');
  }
  return resolve(value);
}

function mappedWorkdir(
  repoRoot: string,
  repositories: Readonly<Record<string, string>>,
  repositoryId: string,
): string | undefined {
  const configured = repositories[repositoryId];
  if (typeof configured !== 'string' || configured.length === 0 || isAbsolute(configured)) return undefined;
  const workdir = resolve(repoRoot, configured);
  const child = relative(repoRoot, workdir);
  if (!child || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) {
    return undefined;
  }
  return workdir;
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

