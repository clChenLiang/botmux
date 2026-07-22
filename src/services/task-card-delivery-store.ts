import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';

import { withFileLock } from '../utils/file-lock.js';
import {
  durablePrivateWrite,
  pinPrivateStateDirectory,
  readPrivateFile,
  type PrivateFileIdentity,
  type PrivateStateDirectory,
  type PrivateStateHooks,
} from './private-task-state.js';

const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const FEISHU_DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const OPAQUE_ID = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/;

export type TaskCardKind = 'candidate' | 'completion' | 'mr';
export type TaskCardDeliveryStatus = 'sent' | 'duplicate';

export class TaskCardDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TaskCardDeliveryError';
  }
}

interface DeliveryRecord {
  kind: TaskCardKind;
  deliveryId: string;
  inputHash: string;
  uuid: string;
  state: 'attempting' | 'sent';
  attemptedAt: string;
  messageId?: string;
}

interface LedgerState {
  schemaVersion: 1;
  deliveries: Record<string, unknown>;
}

export interface DeliveryStoreRequest {
  kind: TaskCardKind;
  deliveryId: string;
  inputHash: string;
  now: string;
  send: (uuid: string) => Promise<string>;
  afterSend: (messageId: string) => Promise<void>;
}

export async function executeTaskCardDelivery(
  ledgerPath: string,
  request: DeliveryStoreRequest,
  options: {
    guard?: PrivateStateDirectory;
    privateStateHooks?: PrivateStateHooks;
  } = {},
): Promise<TaskCardDeliveryStatus> {
  if (!isAbsolute(ledgerPath) || !OPAQUE_ID.test(request.deliveryId)
    || !/^[a-f0-9]{64}$/.test(request.inputHash) || !isCanonicalInstant(request.now)) {
    throw new TaskCardDeliveryError('ERR_TASK_CARD_INPUT');
  }
  const ownedGuard = options.guard ? undefined : await pinPrivateStateDirectory(dirname(ledgerPath))
    .catch(() => { throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE'); });
  const guard = options.guard ?? ownedGuard!;
  const key = hash(`${request.kind}\0${request.deliveryId}`);
  try { return await withFileLock(ledgerPath, async () => {
    await revalidate(guard);
    const loaded = await readLedger(ledgerPath, true, guard, options.privateStateHooks);
    const state = loaded?.state ?? emptyLedger();
    const existingValue = Object.prototype.hasOwnProperty.call(state.deliveries, key)
      ? state.deliveries[key] : undefined;
    let record: DeliveryRecord;
    if (existingValue !== undefined) {
      record = parseDelivery(existingValue);
      if (record.kind !== request.kind || record.deliveryId !== request.deliveryId
        || record.inputHash !== request.inputHash) {
        throw new TaskCardDeliveryError('ERR_TASK_CARD_CONFLICT');
      }
      if (record.state === 'sent') {
        await request.afterSend(record.messageId!);
        await revalidate(guard);
        return 'duplicate';
      }
      if (Date.parse(request.now) - Date.parse(record.attemptedAt) >= FEISHU_DEDUPE_WINDOW_MS) {
        throw new TaskCardDeliveryError('ERR_TASK_CARD_UNCERTAIN');
      }
    } else {
      record = {
        kind: request.kind,
        deliveryId: request.deliveryId,
        inputHash: request.inputHash,
        uuid: stableUuid(request.kind, request.deliveryId),
        state: 'attempting',
        attemptedAt: request.now,
      };
      setOwn(state.deliveries, key, record);
      await writeLedger(
        ledgerPath, state, guard, options.privateStateHooks, loaded?.identity ?? null,
      );
      await revalidate(guard);
    }

    let messageId: string;
    await revalidate(guard);
    try { messageId = await request.send(record.uuid); } catch {
      await revalidate(guard);
      throw new TaskCardDeliveryError('ERR_TASK_CARD_SEND');
    }
    await revalidate(guard);
    if (!OPAQUE_ID.test(messageId)) throw new TaskCardDeliveryError('ERR_TASK_CARD_SEND');
    await request.afterSend(messageId);
    await revalidate(guard);
    setOwn(state.deliveries, key, { ...record, state: 'sent', messageId });
    const latest = await readLedger(ledgerPath, false, guard, options.privateStateHooks);
    await writeLedger(ledgerPath, state, guard, options.privateStateHooks, latest.identity);
    await revalidate(guard);
    return 'sent';
  }); } finally {
    await ownedGuard?.close().catch(() => { throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE'); });
  }
}

function emptyLedger(): LedgerState {
  return { schemaVersion: 1, deliveries: Object.create(null) as Record<string, unknown> };
}

interface LoadedLedger {
  state: LedgerState;
  identity: PrivateFileIdentity;
}

async function readLedger(
  path: string,
  allowMissing: true,
  guard: PrivateStateDirectory,
  hooks?: PrivateStateHooks,
): Promise<LoadedLedger | undefined>;
async function readLedger(
  path: string,
  allowMissing: false,
  guard: PrivateStateDirectory,
  hooks?: PrivateStateHooks,
): Promise<LoadedLedger>;
async function readLedger(
  path: string,
  allowMissing: boolean,
  guard: PrivateStateDirectory,
  hooks: PrivateStateHooks = {},
): Promise<LoadedLedger | undefined> {
  try {
    const snapshot = await readPrivateFile(path, MAX_LEDGER_BYTES, allowMissing, guard, hooks);
    if (!snapshot) return undefined;
    const value = JSON.parse(snapshot.raw) as unknown;
    if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'deliveries'])
      || value.schemaVersion !== 1 || !isRecord(value.deliveries)) throw new Error('invalid');
    const deliveries = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value.deliveries)) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid');
      const record = parseDelivery(value.deliveries[key]);
      if (hash(`${record.kind}\0${record.deliveryId}`) !== key) throw new Error('invalid');
      setOwn(deliveries, key, record);
    }
    return {
      state: { schemaVersion: 1, deliveries },
      identity: { device: snapshot.device, inode: snapshot.inode },
    };
  } catch (error) {
    if (error instanceof TaskCardDeliveryError) throw error;
    throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
  }
}

function parseDelivery(value: unknown): DeliveryRecord {
  if (!isRecord(value)
    || !exactKeys(value, ['kind', 'deliveryId', 'inputHash', 'uuid', 'state', 'attemptedAt', 'messageId'], true)
    || !['candidate', 'completion', 'mr'].includes(String(value.kind))
    || typeof value.deliveryId !== 'string' || !OPAQUE_ID.test(value.deliveryId)
    || typeof value.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputHash)
    || typeof value.uuid !== 'string' || value.uuid.length > 50 || !OPAQUE_ID.test(value.uuid)
    || value.uuid !== stableUuid(value.kind as TaskCardKind, value.deliveryId as string)
    || (value.state !== 'attempting' && value.state !== 'sent')
    || !isCanonicalInstant(value.attemptedAt)
    || (value.state === 'sent' && (typeof value.messageId !== 'string' || !OPAQUE_ID.test(value.messageId)))
    || (value.state === 'attempting' && value.messageId !== undefined)) {
    throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
  }
  return value as unknown as DeliveryRecord;
}

async function writeLedger(
  path: string,
  state: LedgerState,
  guard: PrivateStateDirectory,
  hooks: PrivateStateHooks | undefined,
  expected: PrivateFileIdentity | null,
): Promise<void> {
  try { await durablePrivateWrite(path, `${JSON.stringify(state)}\n`, guard, hooks, expected); } catch {
    throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
  }
}

function stableUuid(kind: TaskCardKind, deliveryId: string): string {
  return `tc_${hash(`${kind}\0${deliveryId}`).slice(0, 43)}`;
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

async function revalidate(guard: PrivateStateDirectory): Promise<void> {
  try { await guard.revalidate(); } catch { throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE'); }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], allowMissing = false): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && (allowMissing || keys.length === allowed.length);
}
