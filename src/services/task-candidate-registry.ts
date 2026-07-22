import { dirname, isAbsolute } from 'node:path';

import type { TaskCandidateRecord } from './task-action-dispatch.js';
import {
  durablePrivateWrite,
  pinPrivateStateDirectory,
  readPrivateFile,
  withPrivateStateLock,
  type PrivateFileIdentity,
  type PrivateStateDirectory,
  type PrivateStateHooks,
} from './private-task-state.js';

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

export function createTaskCandidateRegistry(
  registryPath: string,
  options: { privateStateHooks?: PrivateStateHooks } = {},
): TaskCandidateRegistry {
  if (typeof registryPath !== 'string' || !isAbsolute(registryPath)) {
    throw new Error('task candidate registry path invalid');
  }
  return {
    async resolve(candidateId) {
      if (!isOpaque(candidateId)) throw new Error('task candidate identifier invalid');
      return withGuard(registryPath, async (guard) => {
        const loaded = await readState(registryPath, true, guard, options.privateStateHooks);
        if (!loaded) return undefined;
        const entry = Object.prototype.hasOwnProperty.call(loaded.state.candidates, candidateId)
          ? loaded.state.candidates[candidateId] : undefined;
        if (entry === undefined) return undefined;
        try { return parseRecord(entry, candidateId); } catch { throw new Error('task candidate registry invalid'); }
      });
    },
    async persist(record) {
      const parsed = parseRecord(record, record?.candidateId);
      return withGuard(registryPath, async (guard) => withPrivateStateLock(
        guard, '.task-candidates.lock', async () => {
          await guard.revalidate();
          const loaded = await readState(registryPath, true, guard, options.privateStateHooks);
          const state = loaded?.state ?? emptyState();
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
          await writeState(registryPath, state, guard, options.privateStateHooks, loaded?.identity ?? null);
          await guard.revalidate();
          return 'created';
        },
      ));
    },
    async bindRootMessage(candidateId, rootMessageId) {
      if (!isOpaque(candidateId) || !isOpaque(rootMessageId)) {
        throw new Error('task candidate identifier invalid');
      }
      return withGuard(registryPath, async (guard) => withPrivateStateLock(
        guard, '.task-candidates.lock', async () => {
          await guard.revalidate();
          const loaded = await readState(registryPath, false, guard, options.privateStateHooks);
          const state = loaded.state;
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
          await writeState(registryPath, state, guard, options.privateStateHooks, loaded.identity);
          await guard.revalidate();
          return 'updated';
        },
      ));
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

interface LoadedRegistry {
  state: RegistryState;
  identity: PrivateFileIdentity;
}

async function readState(
  registryPath: string,
  allowMissing: true,
  guard: PrivateStateDirectory,
  hooks?: PrivateStateHooks,
): Promise<LoadedRegistry | undefined>;
async function readState(
  registryPath: string,
  allowMissing: false,
  guard: PrivateStateDirectory,
  hooks?: PrivateStateHooks,
): Promise<LoadedRegistry>;
async function readState(
  registryPath: string,
  allowMissing: boolean,
  guard: PrivateStateDirectory,
  hooks: PrivateStateHooks = {},
): Promise<LoadedRegistry | undefined> {
  const snapshot = await readPrivateFile(registryPath, MAX_REGISTRY_BYTES, allowMissing, guard, hooks)
    .catch(() => { throw new Error('task candidate registry invalid'); });
  if (!snapshot) return undefined;
  try {
    const value = JSON.parse(snapshot.raw) as unknown;
    if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'candidates'])
      || value.schemaVersion !== 1 || !isRecord(value.candidates)) throw new Error('invalid');
    const candidates = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value.candidates)) {
      if (!isOpaque(key)) throw new Error('invalid');
      Object.defineProperty(candidates, key, {
        value: value.candidates[key], enumerable: true, configurable: true, writable: true,
      });
    }
    return {
      state: { schemaVersion: 1, candidates },
      identity: {
        device: snapshot.device,
        inode: snapshot.inode,
        changeTimeNs: snapshot.changeTimeNs,
        modifyTimeNs: snapshot.modifyTimeNs,
      },
    };
  } catch { throw new Error('task candidate registry invalid'); }
}

async function writeState(
  registryPath: string,
  state: RegistryState,
  guard: PrivateStateDirectory,
  hooks: PrivateStateHooks | undefined,
  expected: PrivateFileIdentity | null,
): Promise<void> {
  await durablePrivateWrite(registryPath, `${JSON.stringify(state)}\n`, guard, hooks, expected);
}

async function withGuard<T>(
  registryPath: string,
  operation: (guard: PrivateStateDirectory) => Promise<T>,
): Promise<T> {
  let guard: PrivateStateDirectory;
  try { guard = await pinPrivateStateDirectory(dirname(registryPath)); } catch {
    throw new Error('task candidate registry invalid');
  }
  try { return await operation(guard); } finally {
    await guard.close().catch(() => { throw new Error('task candidate registry invalid'); });
  }
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
