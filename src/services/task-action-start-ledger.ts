import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface TaskActionStartReceipt {
  sessionId?: string;
  triggerId?: string;
}

export type TaskActionStartState =
  | { state: 'absent' }
  | { state: 'acquired' }
  | { state: 'uncertain' }
  | ({ state: 'started' } & TaskActionStartReceipt);

export interface TaskActionStartLedger {
  inspect(idempotencyKey: string): Exclude<TaskActionStartState, { state: 'acquired' }>;
  begin(idempotencyKey: string, dispatchToken: string): TaskActionStartState;
  complete(
    idempotencyKey: string,
    dispatchToken: string,
    receipt: TaskActionStartReceipt,
  ): void;
  close(): void;
}

type StartRow = {
  state: 'starting' | 'started';
  session_id: string | null;
  trigger_id: string | null;
};

/**
 * Durable exactly-once start fence. `starting` is deliberately sticky: after
 * a crash the daemon cannot prove whether the external session side effect
 * happened, so retrying fails closed instead of risking duplicate work.
 */
export function createTaskActionStartLedger(filePath: string): TaskActionStartLedger {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    throw new Error('task action start ledger path must be absolute');
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  chmodSync(filePath, 0o600);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS task_action_starts (
    idempotency_key TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('starting', 'started')),
    dispatch_token TEXT NOT NULL,
    session_id TEXT,
    trigger_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT
  ) STRICT`);

  const select = db.prepare(`SELECT state, session_id, trigger_id
    FROM task_action_starts WHERE idempotency_key = ?`);
  const insert = db.prepare(`INSERT INTO task_action_starts
    (idempotency_key, state, dispatch_token, created_at)
    VALUES (?, 'starting', ?, ?)`);
  const finish = db.prepare(`UPDATE task_action_starts
    SET state = 'started', session_id = ?, trigger_id = ?, started_at = ?
    WHERE idempotency_key = ? AND state = 'starting' AND dispatch_token = ?`);

  const inspect = (idempotencyKey: string): Exclude<TaskActionStartState, { state: 'acquired' }> => {
    safeId(idempotencyKey, 'idempotency key');
    const row = select.get(idempotencyKey) as StartRow | undefined;
    if (!row) return { state: 'absent' };
    if (row.state === 'starting') return { state: 'uncertain' };
    return {
      state: 'started',
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.trigger_id ? { triggerId: row.trigger_id } : {}),
    };
  };

  return {
    inspect,
    begin(idempotencyKey, dispatchToken) {
      safeId(idempotencyKey, 'idempotency key');
      safeId(dispatchToken, 'dispatch token');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = inspect(idempotencyKey);
        if (existing.state !== 'absent') {
          db.exec('COMMIT');
          return existing;
        }
        insert.run(idempotencyKey, dispatchToken, new Date().toISOString());
        db.exec('COMMIT');
        return { state: 'acquired' };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
        throw error;
      }
    },
    complete(idempotencyKey, dispatchToken, receipt) {
      safeId(idempotencyKey, 'idempotency key');
      safeId(dispatchToken, 'dispatch token');
      const sessionId = optionalId(receipt.sessionId, 'session id');
      const triggerId = optionalId(receipt.triggerId, 'trigger id');
      const result = finish.run(
        sessionId ?? null,
        triggerId ?? null,
        new Date().toISOString(),
        idempotencyKey,
        dispatchToken,
      );
      if (result.changes !== 1) throw new Error('task action start claim is stale');
    },
    close() { db.close(); },
  };
}

function safeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new Error(`invalid task action ${label}`);
  }
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  safeId(value, label);
  return value;
}
