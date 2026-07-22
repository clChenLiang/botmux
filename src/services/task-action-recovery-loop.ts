import type {
  TaskActionRecoveryClaim,
  TaskActionRecoveryOptions,
} from './task-action-sink.js';

export interface TaskActionRecoveryLoopDeps {
  intervalMs: number;
  leaseMs: number;
  limit?: number;
  now?: () => string;
  reconcile: () => unknown | Promise<unknown>;
  claim: (options: TaskActionRecoveryOptions) => Promise<TaskActionRecoveryClaim[]>;
  dispatch: (claim: TaskActionRecoveryClaim) => void | Promise<void>;
  log: (level: 'info' | 'warn', message: string) => void;
}

export interface TaskActionRecoveryLoop {
  start(): Promise<void>;
  runNow(): Promise<void>;
  stop(): void;
}

/** Bounded non-overlapping recovery. Claim failures remain leased in Task OS;
 * a later cycle can reclaim them after expiry with a fresh fencing token. */
export function createTaskActionRecoveryLoop(deps: TaskActionRecoveryLoopDeps): TaskActionRecoveryLoop {
  const limit = deps.limit ?? 16;
  if (!Number.isSafeInteger(deps.intervalMs) || deps.intervalMs < 1_000
    || !Number.isSafeInteger(deps.leaseMs) || deps.leaseMs <= deps.intervalMs
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('task recovery interval, lease, or limit is invalid');
  }
  const now = deps.now ?? (() => new Date().toISOString());
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let stopped = false;

  const runCycle = async (): Promise<void> => {
    try {
      await deps.reconcile();
      const claims = await deps.claim({ limit, leaseMs: deps.leaseMs, now: now() });
      for (let index = 0; index < claims.length; index += 1) {
        const claim = claims[index]!;
        try {
          await deps.dispatch(claim);
        } catch {
          deps.log('warn', `[task-action] recovery item ${index + 1}/${claims.length} failed; lease remains retryable`);
        }
      }
      if (claims.length > 0) {
        deps.log('info', `[task-action] recovery processed ${claims.length} claimed item(s)`);
      }
    } catch {
      deps.log('warn', '[task-action] recovery cycle failed; durable state remains retryable');
    }
  };

  const runNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    const current = runCycle().finally(() => {
      if (running === current) running = undefined;
    });
    running = current;
    return current;
  };

  return {
    start() {
      if (starting) return starting;
      if (timer || stopped) return Promise.resolve();
      starting = (async () => {
        await runNow();
        if (stopped || timer) return;
        timer = setInterval(() => { void runNow(); }, deps.intervalMs);
        timer.unref?.();
      })();
      return starting;
    },
    runNow,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
