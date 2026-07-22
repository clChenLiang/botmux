import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { TaskCandidateRecord } from './task-action-dispatch.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

const OPAQUE_ID = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const REQUIRED_RECORD_KEYS = [
  'candidateId', 'repositoryId', 'chatId', 'prompt', 'sourceRef',
] as const;
const OPTIONAL_RECORD_KEYS = ['rootMessageId', 'originalSessionId'] as const;

export interface TaskCandidateRegistry {
  resolve(candidateId: string): Promise<TaskCandidateRecord | undefined>;
  persist(record: TaskCandidateRecord): Promise<'created' | 'duplicate'>;
  bindRootMessage(candidateId: string, rootMessageId: string): Promise<'updated' | 'duplicate'>;
}

export function createTaskCandidateRegistry(registryPath: string): TaskCandidateRegistry {
  if (typeof registryPath !== 'string' || !isAbsolute(registryPath)) {
    throw new Error('task candidate registry path invalid');
  }
  return {
    async resolve(candidateId) {
      if (!isOpaque(candidateId)) throw new Error('task candidate identifier invalid');
      const state = await readState(registryPath, true);
      if (!state) return undefined;
      const entry = Object.prototype.hasOwnProperty.call(state.candidates, candidateId)
        ? state.candidates[candidateId] : undefined;
      if (entry === undefined) return undefined;
      try { return parseRecord(entry, candidateId); } catch { throw new Error('task candidate registry invalid'); }
    },
    async persist(record) {
      const parsed = parseRecord(record, record?.candidateId);
      return withFileLock(registryPath, async () => {
        const state = (await readState(registryPath, true)) ?? emptyState();
        const existing = Object.prototype.hasOwnProperty.call(state.candidates, parsed.candidateId)
          ? state.candidates[parsed.candidateId] : undefined;
        if (existing !== undefined) {
          let current: TaskCandidateRecord;
          try { current = parseRecord(existing, parsed.candidateId); } catch { throw new Error('task candidate registry invalid'); }
          const comparableCurrent = { ...current };
          if (parsed.rootMessageId === undefined) delete comparableCurrent.rootMessageId;
          if (parsed.originalSessionId === undefined) delete comparableCurrent.originalSessionId;
          if (JSON.stringify(comparableCurrent) === JSON.stringify(parsed)) return 'duplicate';
          throw new Error('task candidate registry conflict');
        }
        Object.defineProperty(state.candidates, parsed.candidateId, {
          value: parsed, enumerable: true, configurable: true, writable: true,
        });
        await writeState(registryPath, state);
        return 'created';
      });
    },
    async bindRootMessage(candidateId, rootMessageId) {
      if (!isOpaque(candidateId) || !isOpaque(rootMessageId)) {
        throw new Error('task candidate identifier invalid');
      }
      return withFileLock(registryPath, async () => {
        const state = await readState(registryPath, false);
        const existing = Object.prototype.hasOwnProperty.call(state.candidates, candidateId)
          ? state.candidates[candidateId] : undefined;
        if (existing === undefined) throw new Error('task candidate registry invalid');
        let current: TaskCandidateRecord;
        try { current = parseRecord(existing, candidateId); } catch { throw new Error('task candidate registry invalid'); }
        if (current.rootMessageId === rootMessageId) return 'duplicate';
        if (current.rootMessageId !== undefined) throw new Error('task candidate registry conflict');
        Object.defineProperty(state.candidates, candidateId, {
          value: { ...current, rootMessageId }, enumerable: true, configurable: true, writable: true,
        });
        await writeState(registryPath, state);
        return 'updated';
      });
    },
  };
}

interface RegistryState {
  schemaVersion: 1;
  candidates: Record<string, unknown>;
}

function emptyState(): RegistryState {
  return { schemaVersion: 1, candidates: Object.create(null) as Record<string, unknown> };
}

async function readState(registryPath: string, allowMissing: true): Promise<RegistryState | undefined>;
async function readState(registryPath: string, allowMissing: false): Promise<RegistryState>;
async function readState(registryPath: string, allowMissing: boolean): Promise<RegistryState | undefined> {
  let info;
  try { info = await lstat(registryPath); } catch (error: any) {
    if (error?.code === 'ENOENT' && allowMissing) return undefined;
    throw new Error('task candidate registry unavailable');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o777) !== 0o600 || info.size > MAX_REGISTRY_BYTES) {
    throw new Error('task candidate registry invalid');
  }
  let raw: string;
  try { raw = await readFile(registryPath, 'utf8'); } catch { throw new Error('task candidate registry unavailable'); }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'candidates'])
      || value.schemaVersion !== 1 || !isRecord(value.candidates)) throw new Error('invalid');
    const candidates = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value.candidates)) {
      if (!isOpaque(key)) throw new Error('invalid');
      Object.defineProperty(candidates, key, {
        value: value.candidates[key], enumerable: true, configurable: true, writable: true,
      });
    }
    return { schemaVersion: 1, candidates };
  } catch { throw new Error('task candidate registry invalid'); }
}

async function writeState(registryPath: string, state: RegistryState): Promise<void> {
  await atomicWriteFile(registryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function parseRecord(value: unknown, candidateId: string): TaskCandidateRecord {
  if (!isRecord(value)
    || !exactKeys(value, [...REQUIRED_RECORD_KEYS, ...OPTIONAL_RECORD_KEYS], true)
    || value.candidateId !== candidateId
    || !isSafeText(value.candidateId)
    || !isSafeText(value.repositoryId)
    || !isSafeText(value.chatId)
    || !isSafeText(value.prompt)
    || !isSafeText(value.sourceRef)) {
    throw new Error('invalid');
  }
  if (!isOpaque(value.candidateId)
    || !isOpaque(value.repositoryId)
    || !isOpaque(value.chatId)
    || (value.rootMessageId !== undefined && !isOpaque(value.rootMessageId))
    || (value.originalSessionId !== undefined && !isOpaque(value.originalSessionId))) {
    throw new Error('invalid');
  }
  return {
    candidateId: value.candidateId,
    repositoryId: value.repositoryId,
    chatId: value.chatId,
    prompt: value.prompt,
    sourceRef: value.sourceRef,
    ...(typeof value.rootMessageId === 'string' ? { rootMessageId: value.rootMessageId } : {}),
    ...(typeof value.originalSessionId === 'string'
      ? { originalSessionId: value.originalSessionId }
      : {}),
  };
}

function isSafeText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384;
}

function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  allowMissing = false,
): boolean {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) return false;
  return allowMissing || keys.length === allowed.length;
}
