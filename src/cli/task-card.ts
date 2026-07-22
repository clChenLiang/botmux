import { dirname, isAbsolute, resolve } from 'node:path';

import {
  deliverTaskCard,
  validateTaskCardEnvelope,
  type TaskCardDeliveryDeps,
  type TaskCardKind,
} from '../services/task-card-delivery.js';
import {
  pinPrivateStateDirectory,
  readPrivateFile,
  type PrivateStateDirectory,
} from '../services/private-task-state.js';

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
    let guard: PrivateStateDirectory;
    try { guard = await pinPrivateStateDirectory(stateDir); } catch {
      return failure('ERR_TASK_CARD_STATE');
    }
    try {
      const input = await readPrivateInput(stateDir, args[3], guard);
      let parsed: unknown;
      try { parsed = JSON.parse(input); } catch { return failure('ERR_TASK_CARD_INPUT'); }
      validateTaskCardEnvelope(args[1], parsed);
      const deliver = deps.deliver ?? deliverTaskCard;
      const result = await deliver(stateDir, args[1], parsed);
      await guard.revalidate();
      return {
        code: 0,
        stdout: `${JSON.stringify({ success: true, kind: args[1], status: result.status })}\n`,
        stderr: '',
      };
    } finally {
      await guard.close().catch(() => { throw new Error('ERR_TASK_CARD_STATE'); });
    }
  } catch (error) {
    const code = stableCode(error);
    return failure(code);
  }
}

async function readPrivateInput(
  stateDir: string,
  inputPath: string,
  guard: PrivateStateDirectory,
): Promise<string> {
  if (!isCanonicalAbsolute(inputPath) || dirname(inputPath) !== stateDir) {
    throw new Error('ERR_TASK_CARD_INPUT_FILE');
  }
  try {
    await guard.revalidate();
    const snapshot = await readPrivateFile(inputPath, MAX_INPUT_BYTES, false, guard);
    await guard.revalidate();
    if (!snapshot) throw new Error('missing');
    return snapshot.raw;
  } catch { throw new Error('ERR_TASK_CARD_INPUT_FILE'); }
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
