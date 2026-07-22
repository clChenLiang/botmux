import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

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

export interface TaskActionSinkRuntime {
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  platform: NodeJS.Platform;
}

export interface TaskActionDispatchAcknowledgementRequest {
  idempotencyKey: string;
  dispatchToken: string;
}

export interface TaskActionDispatchAcknowledgementResult {
  outcome: 'dispatched' | 'duplicate';
  idempotencyKey: string;
}

export interface TaskActionReconcileResult {
  eligible: number;
  created: number;
  existing: number;
  items: Array<{
    candidateId: string;
    action: typeof TASK_ALLOW_ACTION | typeof TASK_DISCUSS_ACTION | typeof TASK_FEEDBACK_ACTION;
    idempotencyKey: string;
    state: string;
  }>;
}

export interface TaskActionRecoveryClaim {
  action: typeof TASK_ALLOW_ACTION | typeof TASK_DISCUSS_ACTION | typeof TASK_FEEDBACK_ACTION;
  candidateId: string;
  idempotencyKey: string;
  dispatchToken: string;
  claimedAt: string;
  claimExpiresAt: string;
}

export interface TaskActionRecoveryOptions {
  limit: number;
  leaseMs: number;
  now: string;
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

const DEFAULT_RUNTIME: TaskActionSinkRuntime = Object.freeze({
  spawn: (command: string, args: string[], options: SpawnOptions) => spawn(command, args, options),
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => process.kill(pid, signal),
  platform: process.platform,
});

/**
 * Create the narrow process adapter used at the card callback durability
 * boundary. The child receives only explicit argv and a minimal environment.
 */
export function createTaskActionSink(
  untrustedConfig: TaskActionSinkConfig,
  runtime: TaskActionSinkRuntime = DEFAULT_RUNTIME,
): (request: TaskActionPersistenceRequest) => Promise<TaskActionPersistenceResult> {
  const config = parseConfig(untrustedConfig);

  return async (untrustedRequest) => {
    const request = parseRequest(untrustedRequest);
    const stdout = await invokeTaskOs(config, [
      'task-action', 'apply',
      '--state-dir', config.stateDir,
      '--action', request.action,
      '--subject-type', request.subject.type,
      '--subject-id', request.subject.id,
      '--operator-open-id', request.operatorOpenId,
      '--json',
    ], runtime);
    return parseResult(stdout, request);
  };
}

/** Create the fenced completion callback for a successfully dispatched claim. */
export function createTaskActionDispatchAcknowledger(
  untrustedConfig: TaskActionSinkConfig,
  runtime: TaskActionSinkRuntime = DEFAULT_RUNTIME,
): (
  request: TaskActionDispatchAcknowledgementRequest,
) => Promise<TaskActionDispatchAcknowledgementResult> {
  const config = parseConfig(untrustedConfig);
  return async (untrustedRequest) => {
    const request = parseAcknowledgementRequest(untrustedRequest);
    const stdout = await invokeTaskOs(config, [
      'task-action', 'dispatched',
      '--state-dir', config.stateDir,
      '--idempotency-key', request.idempotencyKey,
      '--dispatch-token', request.dispatchToken,
      '--json',
    ], runtime);
    return parseAcknowledgementResult(stdout, request);
  };
}

/** Materialize any decision-before-outbox crash at daemon startup. Claiming
 * remains Task OS's responsibility; recovered claims re-enter through the
 * same exported trigger dependency. */
export function createTaskActionReconciler(
  untrustedConfig: TaskActionSinkConfig,
  runtime: TaskActionSinkRuntime = DEFAULT_RUNTIME,
): () => Promise<TaskActionReconcileResult> {
  const config = parseConfig(untrustedConfig);
  return async () => parseReconcileResult(await invokeTaskOs(config, [
    'task-action', 'reconcile', '--state-dir', config.stateDir, '--json',
  ], runtime));
}

/** Claim only task-action trigger work. Sensitive fencing tokens are read from
 * a private one-shot sidecar; stdout is validated as metadata-only. */
export function createTaskActionRecoveryClaimer(
  untrustedConfig: TaskActionSinkConfig,
  runtime: TaskActionSinkRuntime = DEFAULT_RUNTIME,
): (options: TaskActionRecoveryOptions) => Promise<TaskActionRecoveryClaim[]> {
  const config = parseConfig(untrustedConfig);
  return async (untrustedOptions) => {
    const options = parseRecoveryOptions(untrustedOptions);
    const outputFile = join(
      config.stateDir,
      `task-action-recovery-${process.pid}-${randomUUID()}.json`,
    );
    let identity: FileIdentity | undefined;
    try {
      const stdout = await invokeTaskOs(config, [
        'task-action', 'recover',
        '--state-dir', config.stateDir,
        '--limit', String(options.limit),
        '--lease-ms', String(options.leaseMs),
        '--now', options.now,
        '--output-file', outputFile,
        '--json',
      ], runtime);
      const summary = parseRecoverySummary(stdout);
      const sidecar = await readPrivateRecoveryFile(outputFile);
      identity = sidecar.identity;
      const claims = parseRecoveryClaims(sidecar.raw);
      if (summary.length !== claims.length) throw new Error('count mismatch');
      for (let index = 0; index < claims.length; index += 1) {
        const claim = claims[index]!;
        const metadata = summary[index]!;
        if (claim.action !== metadata.action
          || claim.candidateId !== metadata.candidateId
          || claim.idempotencyKey !== metadata.idempotencyKey
          || claim.claimedAt !== metadata.claimedAt
          || claim.claimExpiresAt !== metadata.claimExpiresAt) {
          throw new Error('recovery metadata mismatch');
        }
      }
      return claims;
    } catch (error) {
      if (error instanceof TaskActionSinkError) throw error;
      throw new TaskActionSinkError('ERR_TASK_ACTION_SINK_PROTOCOL');
    } finally {
      await removeRecoveryFile(outputFile, identity);
    }
  };
}

type FileIdentity = { device: bigint; inode: bigint };

async function readPrivateRecoveryFile(
  filePath: string,
): Promise<{ raw: string; identity: FileIdentity }> {
  const before = await lstat(filePath, { bigint: true });
  const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : before.uid;
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid
    || (before.mode & 0o777n) !== 0o600n || before.size > 1024n * 1024n) {
    throw new Error('unsafe recovery file');
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.uid !== expectedUid || (opened.mode & 0o777n) !== 0o600n
      || opened.size > 1024n * 1024n) throw new Error('recovery file changed');
    return {
      raw: await handle.readFile({ encoding: 'utf8' }),
      identity: { device: opened.dev, inode: opened.ino },
    };
  } finally {
    await handle.close();
  }
}

async function removeRecoveryFile(filePath: string, identity?: FileIdentity): Promise<void> {
  try {
    const current = await lstat(filePath, { bigint: true });
    if (identity && (current.dev !== identity.device || current.ino !== identity.inode)) {
      throw new Error('recovery file was replaced');
    }
    await rm(filePath, { force: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw new TaskActionSinkError('ERR_TASK_ACTION_SINK_PROTOCOL');
  }
}

function parseRecoveryOptions(value: unknown): TaskActionRecoveryOptions {
  try {
    const data = exactDataRecord(value, ['limit', 'leaseMs', 'now'], ['limit', 'leaseMs', 'now']);
    const limit = boundedInteger(data.limit, 0, 1, 1_000);
    const leaseMs = boundedInteger(data.leaseMs, 0, 1_000, 7 * 24 * 60 * 60 * 1_000);
    if (typeof data.now !== 'string' || new Date(data.now).toISOString() !== data.now) {
      throw new Error('invalid instant');
    }
    return { limit, leaseMs, now: data.now };
  } catch {
    throw new TaskActionSinkError('ERR_TASK_ACTION_SINK_INPUT');
  }
}

function parseRecoverySummary(stdout: string): Omit<TaskActionRecoveryClaim, 'dispatchToken'>[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const data = exactDataRecord(parsed, ['count', 'items'], ['count', 'items']);
    if (!Number.isSafeInteger(data.count) || (data.count as number) < 0
      || !Array.isArray(data.items) || data.items.length !== data.count) throw new Error();
    return data.items.map((item) => parseRecoveryRow(item, false));
  } catch {
    throw new TaskActionSinkError('ERR_TASK_ACTION_SINK_PROTOCOL');
  }
}

function parseRecoveryClaims(raw: string): TaskActionRecoveryClaim[] {
  const parsed: unknown = JSON.parse(raw);
  const data = exactDataRecord(parsed, ['items'], ['items']);
  if (!Array.isArray(data.items) || data.items.length > 1_000) throw new Error();
  return data.items.map((item) => parseRecoveryRow(item, true) as TaskActionRecoveryClaim);
}

function parseRecoveryRow(
  value: unknown,
  sensitive: boolean,
): TaskActionRecoveryClaim | Omit<TaskActionRecoveryClaim, 'dispatchToken'> {
  const keys = sensitive
    ? ['action', 'candidateId', 'idempotencyKey', 'dispatchToken', 'claimedAt', 'claimExpiresAt']
    : ['action', 'candidateId', 'idempotencyKey', 'claimedAt', 'claimExpiresAt'];
  const data = exactDataRecord(value, keys, keys);
  if (!TRIGGER_ACTIONS.has(data.action as string)
    || !isOpaqueId(data.candidateId)
    || typeof data.idempotencyKey !== 'string'
    || !/^action:[a-f0-9]{64}$/.test(data.idempotencyKey)
    || !isIsoInstant(data.claimedAt)
    || !isIsoInstant(data.claimExpiresAt)
    || Date.parse(data.claimExpiresAt) <= Date.parse(data.claimedAt)) throw new Error();
  const base = {
    action: data.action as TaskActionRecoveryClaim['action'],
    candidateId: data.candidateId,
    idempotencyKey: data.idempotencyKey,
    claimedAt: data.claimedAt,
    claimExpiresAt: data.claimExpiresAt,
  };
  if (!sensitive) return base;
  if (!isOpaqueId(data.dispatchToken)) throw new Error();
  return { ...base, dispatchToken: data.dispatchToken };
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
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

function parseAcknowledgementRequest(value: unknown): TaskActionDispatchAcknowledgementRequest {
  try {
    const data = exactDataRecord(value, ['idempotencyKey', 'dispatchToken'], [
      'idempotencyKey', 'dispatchToken',
    ]);
    if (!isOpaqueId(data.idempotencyKey) || !isOpaqueId(data.dispatchToken)) {
      throw new Error('invalid acknowledgement identifier');
    }
    return { idempotencyKey: data.idempotencyKey, dispatchToken: data.dispatchToken };
  } catch {
    throw new TaskActionSinkError('ERR_TASK_ACTION_SINK_INPUT');
  }
}

function invokeTaskOs(
  config: SafeConfig,
  commandArgs: string[],
  runtime: TaskActionSinkRuntime,
): Promise<string> {
  const args = [config.taskOsCliPath, ...commandArgs];

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = runtime.spawn(config.nodeExecutable, args, {
        detached: runtime.platform !== 'win32',
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

    let settled = false;
    let terminalCode: TaskActionSinkErrorCode | undefined;
    let totalBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout;

    const collect = (chunk: Buffer | string, keep: boolean): void => {
      if (settled || terminalCode) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > config.maxOutputBytes) {
        beginTermination('ERR_TASK_ACTION_SINK_OUTPUT');
        return;
      }
      if (keep) stdoutChunks.push(buffer);
    };

    const onStdout = (chunk: Buffer | string) => collect(chunk, true);
    const onStderr = (chunk: Buffer | string) => collect(chunk, false);
    const onError = () => settleError(terminalCode ?? 'ERR_TASK_ACTION_SINK_SPAWN');
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (terminalCode) {
        settleError(terminalCode);
        return;
      }
      if (code !== 0 || signal !== null) {
        settleError('ERR_TASK_ACTION_SINK_EXIT');
        return;
      }
      settleSuccess();
    };

    function clearTimers(): void {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    }

    function cleanup(): void {
      clearTimers();
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.stdout?.pause();
      child.stderr?.pause();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.off('error', onError);
      child.off('close', onClose);
      // EventEmitter treats an unhandled late `error` as an exception. This
      // listener is closure-free and makes late child errors harmless.
      child.on('error', ignoreLateChildError);
    }

    function settleError(code: TaskActionSinkErrorCode): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new TaskActionSinkError(code));
    }

    function settleSuccess(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(stdoutChunks).toString('utf8'));
    }

    function beginTermination(code: TaskActionSinkErrorCode): void {
      if (settled || terminalCode) return;
      terminalCode = code;
      terminate(child, 'SIGTERM', runtime);
      killTimer = setTimeout(() => {
        if (settled) return;
        terminate(child, 'SIGKILL', runtime);
        // On Windows and for uninterruptible Unix children termination is best
        // effort. The callback boundary must still settle and release streams.
        settleError(code);
      }, KILL_GRACE_MS);
    }

    child.stdout!.on('data', onStdout);
    child.stderr!.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
    timeout = setTimeout(() => beginTermination('ERR_TASK_ACTION_SINK_TIMEOUT'), config.timeoutMs);
  });
}

function terminate(
  child: ChildProcess,
  signal: NodeJS.Signals,
  runtime: TaskActionSinkRuntime,
): void {
  if (child.pid && runtime.platform !== 'win32') {
    try {
      runtime.killProcess(-child.pid, signal);
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

function ignoreLateChildError(): void {}

function parseResult(
  stdout: string,
  request: TaskActionPersistenceRequest,
): TaskActionPersistenceResult {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const base = exactDataRecord(parsed, [
      'outcome', 'effectiveAction', 'triggerRequired', 'idempotencyKey', 'dispatchToken',
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
      if (Reflect.ownKeys(base).length !== 5
        || !TRIGGER_ACTIONS.has(base.effectiveAction)
        || !isOpaqueId(base.idempotencyKey)
        || !isOpaqueId(base.dispatchToken)) {
        throw new Error('invalid trigger result');
      }
      return {
        outcome: base.outcome,
        effectiveAction: base.effectiveAction as TaskActionPersistenceResult['effectiveAction'],
        triggerRequired: true,
        idempotencyKey: base.idempotencyKey,
        dispatchToken: base.dispatchToken,
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

function parseAcknowledgementResult(
  stdout: string,
  request: TaskActionDispatchAcknowledgementRequest,
): TaskActionDispatchAcknowledgementResult {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const data = exactDataRecord(parsed, ['outcome', 'idempotencyKey'], [
      'outcome', 'idempotencyKey',
    ]);
    if (data.outcome !== 'dispatched' && data.outcome !== 'duplicate') {
      throw new Error('invalid acknowledgement outcome');
    }
    if (!isOpaqueId(data.idempotencyKey) || data.idempotencyKey !== request.idempotencyKey) {
      throw new Error('mismatched acknowledgement');
    }
    return { outcome: data.outcome, idempotencyKey: data.idempotencyKey };
  } catch {
    throw new TaskActionSinkError('ERR_TASK_ACTION_SINK_PROTOCOL');
  }
}

function parseReconcileResult(stdout: string): TaskActionReconcileResult {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const data = exactDataRecord(parsed, ['eligible', 'created', 'existing', 'items'], [
      'eligible', 'created', 'existing', 'items',
    ]);
    if (![data.eligible, data.created, data.existing].every((value) =>
      Number.isSafeInteger(value) && (value as number) >= 0)) throw new Error('invalid count');
    if ((data.created as number) + (data.existing as number) !== data.eligible
      || !Array.isArray(data.items) || data.items.length !== data.eligible) {
      throw new Error('invalid reconcile totals');
    }
    const items = data.items.map((item) => {
      const row = exactDataRecord(item, ['candidateId', 'action', 'idempotencyKey', 'state'], [
        'candidateId', 'action', 'idempotencyKey', 'state',
      ]);
      if (!isOpaqueId(row.candidateId) || !isOpaqueId(row.idempotencyKey)
        || !TRIGGER_ACTIONS.has(row.action as string)
        || typeof row.state !== 'string' || row.state.length === 0 || row.state.length > 32) {
        throw new Error('invalid reconcile item');
      }
      return {
        candidateId: row.candidateId,
        action: row.action as TaskActionReconcileResult['items'][number]['action'],
        idempotencyKey: row.idempotencyKey,
        state: row.state,
      };
    });
    return {
      eligible: data.eligible as number,
      created: data.created as number,
      existing: data.existing as number,
      items,
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
