import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700n;
const PRIVATE_FILE_MODE = 0o600n;

export type PrivateStateStep = 'temp-open' | 'file-fsync' | 'rename' | 'directory-fsync';

/** Deterministic fault/ordering seam used only by security regression tests. */
export interface PrivateStateHooks {
  onStep?: (step: PrivateStateStep) => void;
  failAt?: PrivateStateStep;
  afterReadOpen?: () => void | Promise<void>;
}

export interface PrivateFileIdentity {
  device: bigint;
  inode: bigint;
}

export interface PrivateFileSnapshot extends PrivateFileIdentity {
  raw: string;
}

export interface PrivateStateDirectory {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  revalidate(): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export async function pinPrivateStateDirectory(path: string): Promise<PrivateStateDirectory> {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) stateError();
  await assertCanonicalDirectoryTree(path);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY
      | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch { return stateError(); }
  let initial;
  try {
    initial = await handle.stat({ bigint: true });
    validateDirectoryStat(initial);
  } catch {
    await handle.close().catch(() => undefined);
    return stateError();
  }
  const identity = { device: initial.dev, inode: initial.ino };
  let closed = false;
  const guard: PrivateStateDirectory = {
    path,
    device: identity.device,
    inode: identity.inode,
    async revalidate() {
      if (closed) stateError();
      try {
        await assertCanonicalDirectoryTree(path);
        const [opened, current] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(path, { bigint: true }),
        ]);
        validateDirectoryStat(opened);
        validateDirectoryStat(current);
        if (opened.dev !== identity.device || opened.ino !== identity.inode
          || current.dev !== identity.device || current.ino !== identity.inode) stateError();
      } catch { stateError(); }
    },
    async sync() {
      if (closed) stateError();
      try { await handle.sync(); } catch { stateError(); }
    },
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
  await guard.revalidate();
  return guard;
}

export async function readPrivateFile(
  path: string,
  maxBytes: number,
  allowMissing: boolean,
  guard: PrivateStateDirectory,
  hooks: PrivateStateHooks = {},
): Promise<PrivateFileSnapshot | undefined> {
  assertDirectChild(path, guard);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) stateError();
  await guard.revalidate();
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error: any) {
    await guard.revalidate();
    if (allowMissing && error?.code === 'ENOENT') return undefined;
    return stateError();
  }
  try {
    await hooks.afterReadOpen?.();
    const opened = await handle.stat({ bigint: true });
    validateFileStat(opened, maxBytes);
    await assertPathMatches(path, opened.dev, opened.ino, maxBytes);
    const raw = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat({ bigint: true });
    validateFileStat(after, maxBytes);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) stateError();
    await assertPathMatches(path, opened.dev, opened.ino, maxBytes);
    await guard.revalidate();
    return { raw, device: opened.dev, inode: opened.ino };
  } catch { return stateError(); } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function durablePrivateWrite(
  path: string,
  data: string | Buffer,
  guard: PrivateStateDirectory,
  hooks: PrivateStateHooks = {},
  expected?: PrivateFileIdentity | null,
): Promise<void> {
  assertDirectChild(path, guard);
  await guard.revalidate();
  const expectedIdentity = expected === undefined ? await inspectTarget(path) : expected;
  const temp = join(guard.path, `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  let renamed = false;
  let tempIdentity: PrivateFileIdentity | undefined;
  try {
    handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    emit(hooks, 'temp-open');
    await handle.chmod(0o600);
    await handle.writeFile(data);
    emit(hooks, 'file-fsync');
    await handle.sync();
    const tempStat = await handle.stat({ bigint: true });
    validateFileStat(tempStat, Number.MAX_SAFE_INTEGER);
    tempIdentity = { device: tempStat.dev, inode: tempStat.ino };
    await handle.close();
    handle = undefined;
    await guard.revalidate();
    await assertExpectedTarget(path, expectedIdentity);
    emit(hooks, 'rename');
    await rename(temp, path);
    renamed = true;
    await guard.revalidate();
    await assertPathMatches(path, tempIdentity.device, tempIdentity.inode, Number.MAX_SAFE_INTEGER);
    emit(hooks, 'directory-fsync');
    await guard.sync();
    await guard.revalidate();
  } catch {
    return stateError();
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temp).catch(() => undefined);
  }
}

function emit(hooks: PrivateStateHooks, step: PrivateStateStep): void {
  hooks.onStep?.(step);
  if (hooks.failAt === step) stateError();
}

async function inspectTarget(path: string): Promise<PrivateFileIdentity | null> {
  try {
    const stat = await lstat(path, { bigint: true });
    validateFileStat(stat, Number.MAX_SAFE_INTEGER);
    return { device: stat.dev, inode: stat.ino };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    return stateError();
  }
}

async function assertExpectedTarget(path: string, expected: PrivateFileIdentity | null): Promise<void> {
  if (expected === null) {
    try { await lstat(path); } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      return stateError();
    }
    return stateError();
  }
  const current = await lstat(path, { bigint: true }).catch(() => stateError());
  validateFileStat(current, Number.MAX_SAFE_INTEGER);
  if (current.dev !== expected.device || current.ino !== expected.inode) stateError();
}

async function assertPathMatches(
  path: string,
  device: bigint,
  inode: bigint,
  maxBytes: number,
): Promise<void> {
  const current = await lstat(path, { bigint: true }).catch(() => stateError());
  validateFileStat(current, maxBytes);
  if (current.dev !== device || current.ino !== inode) stateError();
}

async function assertCanonicalDirectoryTree(path: string): Promise<void> {
  try {
    if (await realpath(path) !== path) stateError();
    const root = parse(path).root;
    let current = root;
    for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const stat = await lstat(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) stateError();
    }
    const leaf = await lstat(path, { bigint: true });
    validateDirectoryStat(leaf);
  } catch { stateError(); }
}

function validateDirectoryStat(stat: Awaited<ReturnType<FileHandle['stat']>> & { mode: bigint; uid: bigint }): void {
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : stat.uid;
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE) stateError();
}

function validateFileStat(
  stat: Awaited<ReturnType<FileHandle['stat']>> & { mode: bigint; uid: bigint; size: bigint },
  maxBytes: number,
): void {
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid
    || (stat.mode & 0o777n) !== PRIVATE_FILE_MODE || stat.size > BigInt(maxBytes)) stateError();
}

function assertDirectChild(path: string, guard: PrivateStateDirectory): void {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
    || dirname(path) !== guard.path || basename(path).length === 0) stateError();
}

function stateError(): never {
  throw new Error('ERR_TASK_CARD_STATE');
}
