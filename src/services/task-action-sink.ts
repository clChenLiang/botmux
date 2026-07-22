import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';

import {
  MR_IGNORE_ACTION,
  REPOSITORY_IGNORE_ACTION,
  TASK_ALLOW_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
  TASK_REJECT_ACTION,
} from '../im/lark/task-action-card.js';
import type {
  TaskActionPersistenceRequest,
  TaskActionPersistenceResult,
} from '../im/lark/task-action-card-handler.js';

export interface TaskActionSinkConfig {
  nodeExecutable: string;
  taskOsCliPath: string;
  stateDir: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

type TaskActionSinkErrorCode =
  | 'ERR_TASK_ACTION_SINK_CONFIG'
  | 'ERR_TASK_ACTION_SINK_INPUT'
  | 'ERR_TASK_ACTION_SINK_SPAWN'
  | 'ERR_TASK_ACTION_SINK_TIMEOUT'
  | 'ERR_TASK_ACTION_SINK_OUTPUT'
  | 'ERR_TASK_ACTION_SINK_EXIT'
  | 'ERR_TASK_ACTION_SINK_PROTOCOL';

export class TaskActionSinkError extends Error {
  readonly code: TaskActionSinkErrorCode;

  constructor(code: TaskActionSinkErrorCode) {
    super(messageFor(code));
    this.name = 'TaskActionSinkError';
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1_024 * 1_024;
const KILL_GRACE_MS = 100;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CANDIDATE_ACTIONS = new Set<string>([
  TASK_ALLOW_ACTION,
  TASK_REJECT_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
]);
const PERSISTED_ACTIONS = new Set<string>([
  ...CANDIDATE_ACTIONS,
  MR_IGNORE_ACTION,
  REPOSITORY_IGNORE_ACTION,
]);
const TRIGGER_ACTIONS = new Set<string>([
  TASK_ALLOW_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
]);

type SafeConfig = Required<TaskActionSinkConfig>;
type PlainRecord = Record<string, unknown>;

/**
 * Create the narrow process adapter used at the card callback durability
 * boundary. The child receives only explicit argv and a minimal environment.
 */
export function createTaskActionSink(
  untrustedConfig: TaskActionSinkConfig,
): (request: TaskActionPersistenceRequest) => Promise<TaskActionPersistenceResult> {
  const config = parseConfig(untrustedConfig);

  return async (untrustedRequest) => {
    const request = parseRequest(untrustedRequest);
    const stdout = await invokeTaskOs(config, request);
    return parseResult(stdout, request);
  };
}

function parseConfig(value: unknown): SafeConfig {
  try {
    const data = exactDataRecord(value, [
      'nodeExecutable', 'taskOsCliPath', 'stateDir', 'timeoutMs', 'maxOutputBytes',
    ], ['nodeExecutable', 'taskOsCliPath', 'stateDir']);
    const nodeExecutable = absoluteNonempty(data.nodeExecutable);
    const taskOsCliPath = absoluteNonempty(data.taskOsCliPath);
    const stateDir = absoluteNonempty(data.stateDir);
    if (!nodeExecutable || !taskOsCliPath || !stateDir) throw new Error('invalid path');
    const timeoutMs = boundedInteger(data.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    const maxOutputBytes = boundedInteger(
      data.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      1,
      MAX_OUTPUT_BYTES,
    );
    return { nodeExecutable, taskOsCliPath, stateDir, timeoutMs, maxOutputBytes };
  } catch {
    throw new TaskActionSinkError('ERR_TASK_ACTION_SINK_CONFIG');
  }
}

function parseRequest(value: unknown): TaskActionPersistenceRequest {
  try {
    const data = exactDataRecord(value, ['action', 'subject', 'operatorOpenId'], [
      'action', 'subject', 'operatorOpenId',
    ]);
    const subject = exactDataRecord(data.subject, ['type', 'id'], ['type', 'id']);
    if (typeof data.action !== 'string' || !PERSISTED_ACTIONS.has(data.action)) {
      throw new Error('invalid action');
    }
    if (!isOpaqueId(subject.id) || !isOpaqueId(data.operatorOpenId)) {
      throw new Error('invalid identifier');
    }
    if (!compatible(data.action, subject.type)) throw new Error('incompatible subject');
    return {
      action: data.action as TaskActionPersistenceRequest['action'],
      subject: {
        type: subject.type as TaskActionPersistenceRequest['subject']['type'],
        id: subject.id,
      },
      operatorOpenId: data.operatorOpenId,
    };
  } catch {
    throw new TaskActionSinkError('ERR_TASK_ACTION_SINK_INPUT');
  }
}

function compatible(action: string, subjectType: unknown): boolean {
  if (subjectType === 'candidate') return CANDIDATE_ACTIONS.has(action);
  if (subjectType === 'mr') return action === MR_IGNORE_ACTION;
  if (subjectType === 'repository') return action === REPOSITORY_IGNORE_ACTION;
  return false;
}

function invokeTaskOs(
  config: SafeConfig,
  request: TaskActionPersistenceRequest,
): Promise<string> {
  const args = [
    config.taskOsCliPath,
    'task-action', 'apply',
    '--state-dir', config.stateDir,
    '--action', request.action,
    '--subject-type', request.subject.type,
    '--subject-id', request.subject.id,
    '--operator-open-id', request.operatorOpenId,
    '--json',
  ];

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(config.nodeExecutable, args, {
        detached: process.platform !== 'win32',
        env: {
          PATH: dirname(config.nodeExecutable),
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      reject(new TaskActionSinkError('ERR_TASK_ACTION_SINK_SPAWN'));
      return;
    }

    let terminalCode: TaskActionSinkErrorCode | undefined;
    let totalBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      terminalCode ??= 'ERR_TASK_ACTION_SINK_TIMEOUT';
      terminate(child);
      killTimer = setTimeout(() => terminate(child, 'SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    }, config.timeoutMs);

    const collect = (chunk: Buffer | string, keep: boolean) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > config.maxOutputBytes) {
        terminalCode ??= 'ERR_TASK_ACTION_SINK_OUTPUT';
        terminate(child);
        killTimer ??= setTimeout(() => terminate(child, 'SIGKILL'), KILL_GRACE_MS);
        killTimer.unref();
        return;
      }
      if (keep) stdoutChunks.push(buffer);
    };

    child.stdout!.on('data', (chunk) => collect(chunk, true));
    child.stderr!.on('data', (chunk) => collect(chunk, false));
    child.once('error', () => {
      terminalCode ??= 'ERR_TASK_ACTION_SINK_SPAWN';
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (terminalCode) {
        reject(new TaskActionSinkError(terminalCode));
        return;
      }
      if (killTimer) clearTimeout(killTimer);
      if (code !== 0 || signal !== null) {
        reject(new TaskActionSinkError('ERR_TASK_ACTION_SINK_EXIT'));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString('utf8'));
    });
  });
}

function terminate(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process termination is best effort; close/error still settles the call.
  }
}

function parseResult(
  stdout: string,
  request: TaskActionPersistenceRequest,
): TaskActionPersistenceResult {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const base = exactDataRecord(parsed, [
      'outcome', 'effectiveAction', 'triggerRequired', 'idempotencyKey',
    ], ['outcome', 'effectiveAction', 'triggerRequired']);
    if (base.outcome !== 'recorded' && base.outcome !== 'duplicate' && base.outcome !== 'conflict') {
      throw new Error('invalid outcome');
    }
    if (typeof base.effectiveAction !== 'string'
      || !PERSISTED_ACTIONS.has(base.effectiveAction)
      || !compatible(base.effectiveAction, request.subject.type)) {
      throw new Error('invalid effective action');
    }
    if (base.outcome === 'recorded' && base.effectiveAction !== request.action) {
      throw new Error('recorded mismatch');
    }
    if (base.outcome === 'duplicate' && base.effectiveAction !== request.action) {
      throw new Error('duplicate mismatch');
    }
    if (base.outcome === 'conflict' && base.effectiveAction === request.action) {
      throw new Error('conflict mismatch');
    }
    if (typeof base.triggerRequired !== 'boolean') throw new Error('invalid trigger flag');

    if (base.triggerRequired) {
      if (Reflect.ownKeys(base).length !== 4
        || !TRIGGER_ACTIONS.has(base.effectiveAction)
        || !isOpaqueId(base.idempotencyKey)) {
        throw new Error('invalid trigger result');
      }
      return {
        outcome: base.outcome,
        effectiveAction: base.effectiveAction as TaskActionPersistenceResult['effectiveAction'],
        triggerRequired: true,
        idempotencyKey: base.idempotencyKey,
      };
    }
    if (Reflect.ownKeys(base).length !== 3) throw new Error('unexpected result field');
    return {
      outcome: base.outcome,
      effectiveAction: base.effectiveAction as TaskActionPersistenceResult['effectiveAction'],
      triggerRequired: false,
    };
  } catch {
    throw new TaskActionSinkError('ERR_TASK_ACTION_SINK_PROTOCOL');
  }
}

function exactDataRecord(value: unknown, allowed: string[], required: string[]): PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not record');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('exotic record');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw new Error('extra key');
  if (required.some((key) => !keys.includes(key))) throw new Error('missing key');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('accessor');
  }
  return value as PlainRecord;
}

function absoluteNonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) ? value : undefined;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error('invalid bound');
  }
  return value as number;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function messageFor(code: TaskActionSinkErrorCode): string {
  switch (code) {
    case 'ERR_TASK_ACTION_SINK_CONFIG': return 'Task action sink configuration is invalid';
    case 'ERR_TASK_ACTION_SINK_INPUT': return 'Task action request is invalid';
    case 'ERR_TASK_ACTION_SINK_SPAWN': return 'Task action process could not be started';
    case 'ERR_TASK_ACTION_SINK_TIMEOUT': return 'Task action process timed out';
    case 'ERR_TASK_ACTION_SINK_OUTPUT': return 'Task action process output exceeded the limit';
    case 'ERR_TASK_ACTION_SINK_EXIT': return 'Task action process failed';
    case 'ERR_TASK_ACTION_SINK_PROTOCOL': return 'Task action process returned an invalid response';
  }
}
