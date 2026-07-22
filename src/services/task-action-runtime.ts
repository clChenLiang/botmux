import type {
  TaskActionHandlerDeps,
  TaskActionPersistenceRequest,
  TaskActionPersistenceResult,
} from '../im/lark/task-action-card-handler.js';
import type { TaskActionTriggerRequest } from '../im/lark/task-action-card-handler.js';
import {
  createTaskActionDispatch,
  type TaskActionDispatchDeps,
  type TaskCandidateRecord,
} from './task-action-dispatch.js';
import type {
  TaskActionDispatchAcknowledgementRequest,
  TaskActionDispatchAcknowledgementResult,
} from './task-action-sink.js';
import type {
  TaskActionStartLedger,
  TaskActionStartReceipt,
} from './task-action-start-ledger.js';

export interface TaskActionTurnRequest {
  chatId?: string;
  rootMessageId?: string;
  sessionId?: string;
  workingDir?: string;
  instruction: string;
  sourceRef?: string;
  mode: 'work' | 'discussion' | 'feedback';
  candidateId: string;
  dedupKey: string;
  dispatchToken: string;
  verifyWorkingDir?: () => void;
}

export interface TaskActionRuntimeConfig {
  ownerOpenId: string;
  repoRoot: string;
  repositories: Readonly<Record<string, string | readonly string[]>>;
  fallbackChatId: string;
  resolveCandidate: TaskActionDispatchDeps['resolveCandidate'];
  startLedger: TaskActionStartLedger;
  hasActiveSession: (sessionId: string) => boolean | Promise<boolean>;
  persist: (request: TaskActionPersistenceRequest) => Promise<TaskActionPersistenceResult>;
  acknowledge: (
    request: TaskActionDispatchAcknowledgementRequest,
  ) => Promise<TaskActionDispatchAcknowledgementResult>;
  startTurn: (request: TaskActionTurnRequest) => void | TaskActionStartReceipt
    | Promise<void | TaskActionStartReceipt>;
}

export interface TaskActionRuntime {
  handlerDeps: TaskActionHandlerDeps;
  /** Narrow recovery ingress for claims obtained from Task OS after reconcile. */
  recover: (request: TaskActionTriggerRequest) => Promise<void>;
}

export function createTaskActionRuntime(config: TaskActionRuntimeConfig): TaskActionRuntime {
  const trigger = createTaskActionDispatch({
    repoRoot: config.repoRoot,
    repositories: config.repositories,
    resolveCandidate: config.resolveCandidate,
    startLedger: config.startLedger,
    hasActiveSession: config.hasActiveSession,
    acknowledge: config.acknowledge,
    start: async (request, verifyWorkingDir) => {
      const chatId = request.chatId ?? config.fallbackChatId;
      if (!chatId && !request.sessionId) throw new Error('task discussion target unavailable');
      const receipt = await config.startTurn({
        chatId: request.sessionId ? undefined : chatId,
        rootMessageId: request.sessionId ? undefined : request.rootMessageId,
        sessionId: request.sessionId,
        workingDir: request.workdir,
        instruction: request.prompt,
        sourceRef: request.sourceRef,
        mode: request.mode,
        candidateId: request.candidateId,
        dedupKey: request.idempotencyKey,
        dispatchToken: request.dispatchToken,
        verifyWorkingDir,
      });
      return receipt ?? {};
    },
  });
  return {
    handlerDeps: {
      isAuthorized: async (operatorOpenId) => operatorOpenId === config.ownerOpenId,
      persist: config.persist,
      trigger,
    },
    recover: trigger,
  };
}

export type { TaskCandidateRecord };
