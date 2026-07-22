import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

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
): Promise<TaskCardDeliveryStatus> {
  if (!isAbsolute(ledgerPath) || !OPAQUE_ID.test(request.deliveryId)
    || !/^[a-f0-9]{64}$/.test(request.inputHash) || !Number.isFinite(Date.parse(request.now))) {
    throw new TaskCardDeliveryError('ERR_TASK_CARD_INPUT');
  }
  const key = hash(`${request.kind}\0${request.deliveryId}`);
  return withFileLock(ledgerPath, async () => {
    const state = (await readLedger(ledgerPath, true)) ?? emptyLedger();
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
        uuid: `tc_${hash(`${request.kind}\0${request.deliveryId}`).slice(0, 43)}`,
        state: 'attempting',
        attemptedAt: request.now,
      };
      setOwn(state.deliveries, key, record);
      await writeLedger(ledgerPath, state);
    }

    let messageId: string;
    try { messageId = await request.send(record.uuid); } catch {
      throw new TaskCardDeliveryError('ERR_TASK_CARD_SEND');
    }
    if (!OPAQUE_ID.test(messageId)) throw new TaskCardDeliveryError('ERR_TASK_CARD_SEND');
    await request.afterSend(messageId);
    setOwn(state.deliveries, key, { ...record, state: 'sent', messageId });
    await writeLedger(ledgerPath, state);
    return 'sent';
  });
}

function emptyLedger(): LedgerState {
  return { schemaVersion: 1, deliveries: Object.create(null) as Record<string, unknown> };
}

async function readLedger(path: string, allowMissing: boolean): Promise<LedgerState | undefined> {
  let info;
  try { info = await lstat(path); } catch (error: any) {
    if (error?.code === 'ENOENT' && allowMissing) return undefined;
    throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o777) !== 0o600 || info.size > MAX_LEDGER_BYTES) {
    throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
  }
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'deliveries'])
      || value.schemaVersion !== 1 || !isRecord(value.deliveries)) throw new Error('invalid');
    const deliveries = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value.deliveries)) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid');
      const record = parseDelivery(value.deliveries[key]);
      if (hash(`${record.kind}\0${record.deliveryId}`) !== key) throw new Error('invalid');
      setOwn(deliveries, key, record);
    }
    return { schemaVersion: 1, deliveries };
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
    || (value.state !== 'attempting' && value.state !== 'sent')
    || typeof value.attemptedAt !== 'string' || !Number.isFinite(Date.parse(value.attemptedAt))
    || (value.state === 'sent' && (typeof value.messageId !== 'string' || !OPAQUE_ID.test(value.messageId)))
    || (value.state === 'attempting' && value.messageId !== undefined)) {
    throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
  }
  return value as unknown as DeliveryRecord;
}

async function writeLedger(path: string, state: LedgerState): Promise<void> {
  try { await atomicWriteFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 }); } catch {
    throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
  }
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
