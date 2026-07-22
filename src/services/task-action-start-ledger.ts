import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
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
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || normalize(filePath) !== filePath) {
    throw new Error('task action start ledger path must be absolute');
  }
  filePath = preparePrivateLedgerPath(filePath);
  const db = withPrivateUmask(() => new DatabaseSync(filePath));
  withPrivateUmask(() => {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    migrateLegacyTable(db);
    db.exec(`CREATE TABLE IF NOT EXISTS task_action_starts (
    idempotency_key TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('starting', 'started')),
    dispatch_fence TEXT NOT NULL,
    session_id TEXT,
    trigger_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT
  ) STRICT`);
  });
  secureLedgerFiles(filePath);

  const select = db.prepare(`SELECT state, session_id, trigger_id
    FROM task_action_starts WHERE idempotency_key = ?`);
  const insert = db.prepare(`INSERT INTO task_action_starts
    (idempotency_key, state, dispatch_fence, created_at)
    VALUES (?, 'starting', ?, ?)`);
  const finish = db.prepare(`UPDATE task_action_starts
    SET state = 'started', session_id = ?, trigger_id = ?, started_at = ?
    WHERE idempotency_key = ? AND state = 'starting' AND dispatch_fence = ?`);

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
      withPrivateUmask(() => db.exec('BEGIN IMMEDIATE'));
      try {
        const existing = inspect(idempotencyKey);
        if (existing.state !== 'absent') {
          db.exec('COMMIT');
          return existing;
        }
        insert.run(idempotencyKey, tokenFence(dispatchToken), new Date().toISOString());
        db.exec('COMMIT');
        secureLedgerFiles(filePath);
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
        tokenFence(dispatchToken),
      );
      if (result.changes !== 1) throw new Error('task action start claim is stale');
      secureLedgerFiles(filePath);
    },
    close() {
      secureLedgerFiles(filePath);
      db.close();
      secureLedgerFiles(filePath);
    },
  };
}

function preparePrivateLedgerPath(filePath: string): string {
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent, { bigint: true });
  const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : parentStat.uid;
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== expectedUid
    || realpathSync(parent) !== resolve(parent)) {
    throw new Error('task action ledger directory must be canonical and non-symlink');
  }
  chmodSync(parent, 0o700);
  if (existsSync(filePath)) {
    const fileStat = lstatSync(filePath, { bigint: true });
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.uid !== expectedUid) {
      throw new Error('task action ledger path must be a regular non-symlink file');
    }
    chmodSync(filePath, 0o600);
  }
  return filePath;
}

function secureLedgerFiles(filePath: string): void {
  const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
      || (expectedUid !== undefined && stat.uid !== expectedUid)) {
      throw new Error('task action ledger file is unsafe');
    }
    chmodSync(candidate, 0o600);
  }
}

function withPrivateUmask<T>(operation: () => T): T {
  const previous = process.umask(0o077);
  try { return operation(); } finally { process.umask(previous); }
}

function tokenFence(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function migrateLegacyTable(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(task_action_starts)').all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === 'dispatch_token')) return;
  type LegacyRow = {
    idempotency_key: string;
    state: string;
    dispatch_token: string;
    session_id: string | null;
    trigger_id: string | null;
    created_at: string;
    started_at: string | null;
  };
  const rows = db.prepare('SELECT * FROM task_action_starts').all() as LegacyRow[];
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE task_action_starts_secure (
      idempotency_key TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('starting', 'started')),
      dispatch_fence TEXT NOT NULL,
      session_id TEXT,
      trigger_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT
    ) STRICT;`);
  try {
    const insert = db.prepare(`INSERT INTO task_action_starts_secure
      (idempotency_key, state, dispatch_fence, session_id, trigger_id, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      insert.run(row.idempotency_key, row.state, tokenFence(row.dispatch_token),
        row.session_id, row.trigger_id, row.created_at, row.started_at);
    }
    db.exec(`DROP TABLE task_action_starts;
      ALTER TABLE task_action_starts_secure RENAME TO task_action_starts;
      COMMIT;`);
    db.exec('VACUUM');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
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
