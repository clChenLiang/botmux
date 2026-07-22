import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  deliverTaskCard,
  validateTaskCardEnvelope,
  type TaskCardDeliveryDeps,
  type TaskCardKind,
} from '../services/task-card-delivery.js';

const MAX_INPUT_BYTES = 256 * 1024;

export interface TaskCardCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TaskCardCommandDeps {
  stateDir?: string;
  deliver?: (
    stateDir: string, kind: TaskCardKind, input: unknown, deps?: TaskCardDeliveryDeps,
  ) => Promise<{ status: 'sent' | 'duplicate' }>;
}

export async function runTaskCardCommand(
  args: string[],
  deps: TaskCardCommandDeps = {},
): Promise<TaskCardCommandResult> {
  try {
    if (args.length !== 4 || args[0] !== 'send' || args[2] !== '--input-file'
      || !isKind(args[1])) return failure('ERR_TASK_CARD_USAGE');
    const stateDir = deps.stateDir ?? process.env.BOTMUX_TASK_OS_STATE_DIR;
    if (!stateDir) return failure('ERR_TASK_CARD_STATE');
    await validatePrivateDirectory(stateDir);
    const input = await readPrivateInput(stateDir, args[3]);
    let parsed: unknown;
    try { parsed = JSON.parse(input); } catch { return failure('ERR_TASK_CARD_INPUT'); }
    validateTaskCardEnvelope(args[1], parsed);
    const deliver = deps.deliver ?? deliverTaskCard;
    const result = await deliver(stateDir, args[1], parsed);
    return {
      code: 0,
      stdout: `${JSON.stringify({ success: true, kind: args[1], status: result.status })}\n`,
      stderr: '',
    };
  } catch (error) {
    const code = stableCode(error);
    return failure(code);
  }
}

async function validatePrivateDirectory(path: string): Promise<void> {
  if (!isCanonicalAbsolute(path)) throw new Error('ERR_TASK_CARD_STATE');
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info.uid)
      || (info.mode & 0o777) !== 0o700) {
      throw new Error('invalid');
    }
  } catch { throw new Error('ERR_TASK_CARD_STATE'); }
}

async function readPrivateInput(stateDir: string, inputPath: string): Promise<string> {
  if (!isCanonicalAbsolute(inputPath) || dirname(inputPath) !== stateDir) {
    throw new Error('ERR_TASK_CARD_INPUT_FILE');
  }
  let before;
  try { before = await lstat(inputPath); } catch { throw new Error('ERR_TASK_CARD_INPUT_FILE'); }
  if (!before.isFile() || before.isSymbolicLink() || !ownedByCurrentUser(before.uid)
    || (before.mode & 0o777) !== 0o600 || before.size > MAX_INPUT_BYTES
    || await realpath(inputPath) !== join(await realpath(stateDir), basename(inputPath))) {
    throw new Error('ERR_TASK_CARD_INPUT_FILE');
  }
  let handle;
  try {
    handle = await open(inputPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || !ownedByCurrentUser(after.uid) || (after.mode & 0o777) !== 0o600
      || after.size > MAX_INPUT_BYTES) throw new Error('invalid');
    return await handle.readFile('utf8');
  } catch { throw new Error('ERR_TASK_CARD_INPUT_FILE'); } finally {
    try { await handle?.close(); } catch { /* best effort */ }
  }
}

function stableCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^ERR_TASK_CARD_[A-Z_]+$/.test(message) ? message : 'ERR_TASK_CARD_INTERNAL';
}

function failure(code: string): TaskCardCommandResult {
  return { code: 2, stdout: '', stderr: `${code}\n` };
}

function isKind(value: string): value is TaskCardKind {
  return value === 'candidate' || value === 'completion' || value === 'mr';
}

function isCanonicalAbsolute(path: string): boolean {
  return typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
}

function ownedByCurrentUser(uid: number): boolean {
  const current = process.getuid?.();
  return current === undefined || uid === current;
}
