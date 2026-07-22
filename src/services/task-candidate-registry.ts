import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { TaskCandidateRecord } from './task-action-dispatch.js';

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const REQUIRED_RECORD_KEYS = [
  'candidateId', 'repositoryId', 'chatId', 'prompt', 'sourceRef',
] as const;
const OPTIONAL_RECORD_KEYS = ['rootMessageId', 'originalSessionId'] as const;

export interface TaskCandidateRegistry {
  resolve(candidateId: string): Promise<TaskCandidateRecord | undefined>;
}

export function createTaskCandidateRegistry(registryPath: string): TaskCandidateRegistry {
  if (typeof registryPath !== 'string' || !isAbsolute(registryPath)) {
    throw new Error('task candidate registry path invalid');
  }
  return {
    async resolve(candidateId) {
      if (!isOpaque(candidateId)) throw new Error('task candidate identifier invalid');
      let raw: string;
      try {
        raw = await readFile(registryPath, { encoding: 'utf8' });
      } catch (error: any) {
        if (error?.code === 'ENOENT') return undefined;
        throw new Error('task candidate registry unavailable');
      }
      if (Buffer.byteLength(raw) > MAX_REGISTRY_BYTES) {
        throw new Error('task candidate registry invalid');
      }
      try {
        const state = JSON.parse(raw) as unknown;
        if (!isRecord(state) || !exactKeys(state, ['schemaVersion', 'candidates'])
          || state.schemaVersion !== 1 || !isRecord(state.candidates)) {
          throw new Error('invalid');
        }
        const entry = state.candidates[candidateId];
        if (entry === undefined) return undefined;
        return parseRecord(entry, candidateId);
      } catch {
        throw new Error('task candidate registry invalid');
      }
    },
  };
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
