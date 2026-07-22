import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700n;
const PRIVATE_FILE_MODE = 0o600n;

export type PrivateStateStep = 'temp-open' | 'file-fsync' | 'rename' | 'directory-fsync';

/** Deterministic fault/ordering seam used only by security regression tests. */
export interface PrivateStateHooks {
  onStep?: (step: PrivateStateStep) => void;
  failAt?: PrivateStateStep;
  afterReadOpen?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
}

export interface PrivateFileIdentity {
  device: bigint;
  inode: bigint;
  changeTimeNs: bigint;
  modifyTimeNs: bigint;
}

export interface PrivateFileSnapshot extends PrivateFileIdentity {
  raw: string;
}

export interface PrivateStateDirectory {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  /** Inherited as fd 3 by the isolated openat/renameat/flock helper. */
  readonly descriptor: number;
  revalidate(): Promise<void>;
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
    descriptor: handle.fd,
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
    const opened = await handle.stat({ bigint: true });
    validateFileStat(opened, maxBytes);
    await hooks.afterReadOpen?.();
    await assertPathMatches(path, opened.dev, opened.ino, maxBytes);
    const raw = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat({ bigint: true });
    validateFileStat(after, maxBytes);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.ctimeNs !== opened.ctimeNs || after.mtimeNs !== opened.mtimeNs) stateError();
    await assertPathMatches(path, opened.dev, opened.ino, maxBytes);
    await guard.revalidate();
    return {
      raw,
      device: opened.dev,
      inode: opened.ino,
      changeTimeNs: opened.ctimeNs,
      modifyTimeNs: opened.mtimeNs,
    };
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
  await runDirfdWriter({
    target: basename(path),
    temp: basename(temp),
    data: Buffer.isBuffer(data) ? data : Buffer.from(data),
    expected: expectedIdentity,
    guard,
    hooks,
  });
  await guard.revalidate();
}

export async function withPrivateStateLock<T>(
  guard: PrivateStateDirectory,
  lockName: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!/^\.[A-Za-z0-9._-]{1,120}\.lock$/.test(lockName)) stateError();
  await guard.revalidate();
  const child = spawnPrivateHelper(PYTHON_LOCK_HELPER, [lockName], guard, ['pipe', 'pipe', 'pipe']);
  let stderrBytes = 0;
  child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.byteLength; });
  try { await waitForHelperLine(child, 'LOCKED', 5_000); } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await waitForHelperExit(child, 1_000);
    return stateError();
  }
  try {
    if (stderrBytes > 4_096) stateError();
    await guard.revalidate();
    return await operation();
  } finally {
    child.stdin?.end('RELEASE\n');
    await waitForHelperExit(child, 1_000);
  }
}

async function inspectTarget(path: string): Promise<PrivateFileIdentity | null> {
  try {
    const stat = await lstat(path, { bigint: true });
    validateFileStat(stat, Number.MAX_SAFE_INTEGER);
    return {
      device: stat.dev,
      inode: stat.ino,
      changeTimeNs: stat.ctimeNs,
      modifyTimeNs: stat.mtimeNs,
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    return stateError();
  }
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

interface DirfdWriterRequest {
  target: string;
  temp: string;
  data: Buffer;
  expected: PrivateFileIdentity | null;
  guard: PrivateStateDirectory;
  hooks: PrivateStateHooks;
}

async function runDirfdWriter(request: DirfdWriterRequest): Promise<void> {
  const child = spawnPrivateHelper(PYTHON_WRITE_HELPER, [], request.guard, ['pipe', 'pipe', 'pipe']);
  const expectedSteps: PrivateStateStep[] = [
    'temp-open', 'file-fsync', 'rename', 'directory-fsync',
  ];
  let stepIndex = 0;
  let stdoutBuffer = '';
  let stderrBytes = 0;
  let sawOk = false;
  let processingError: unknown;
  let processing = Promise.resolve();
  child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.byteLength; });
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    while (stdoutBuffer.includes('\n')) {
      const end = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, end);
      stdoutBuffer = stdoutBuffer.slice(end + 1);
      processing = processing.then(async () => {
        if (line === 'OK') {
          if (stepIndex !== expectedSteps.length) stateError();
          sawOk = true;
          return;
        }
        if (!line.startsWith('STEP ')) stateError();
        const step = line.slice(5) as PrivateStateStep;
        if (step !== expectedSteps[stepIndex]) stateError();
        stepIndex += 1;
        request.hooks.onStep?.(step);
        if (step === 'rename') {
          await request.hooks.beforeRename?.();
          await request.guard.revalidate();
        }
        if (request.hooks.failAt === step) {
          child.stdin?.write('ABORT\n');
          stateError();
        }
        child.stdin?.write('CONTINUE\n');
      }).catch((error) => {
        processingError = error;
        child.stdin?.write('ABORT\n');
      });
    }
  });
  child.stdin?.write(`${JSON.stringify({
    target: request.target,
    temp: request.temp,
    data: request.data.toString('base64'),
    expected: request.expected
      ? {
        device: request.expected.device.toString(),
        inode: request.expected.inode.toString(),
        changeTimeNs: request.expected.changeTimeNs.toString(),
        modifyTimeNs: request.expected.modifyTimeNs.toString(),
      }
      : null,
  })}\n`);
  const exitCode = await waitForHelperExit(child, 10_000);
  await processing;
  if (processingError || exitCode !== 0 || !sawOk || stderrBytes > 4_096) stateError();
}

function spawnPrivateHelper(
  source: string,
  args: string[],
  guard: PrivateStateDirectory,
  stdio: ['pipe', 'pipe', 'pipe'],
): ChildProcess {
  if (process.platform === 'win32') stateError();
  try {
    return spawn('/usr/bin/python3', ['-I', '-S', '-c', source, ...args], {
      shell: false,
      windowsHide: true,
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: [...stdio, guard.descriptor],
    });
  } catch { return stateError(); }
}

function waitForHelperLine(child: ChildProcess, expected: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end >= 0) finish(buffer.slice(0, end) === expected);
    };
    const onExit = () => finish(false);
    const onError = () => finish(false);
    const finish = (success: boolean) => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (success) resolvePromise(); else rejectPromise(new Error('helper failed'));
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForHelperExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
      resolvePromise(code);
    };
    const onExit = (code: number | null) => finish(code);
    const onError = () => finish(null);
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode);
  });
}

const PYTHON_WRITE_HELPER = String.raw`
import base64, json, os, stat, sys
d = 3
cfg = json.loads(sys.stdin.readline())
target = cfg['target']
temp = cfg['temp']
renamed = False
fd = -1
def step(name):
    print('STEP ' + name, flush=True)
    if sys.stdin.readline().strip() != 'CONTINUE':
        raise RuntimeError('aborted')
def private_regular(st):
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and (st.st_mode & 0o777) == 0o600
try:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, 'O_NOFOLLOW'): flags |= os.O_NOFOLLOW
    fd = os.open(temp, flags, 0o600, dir_fd=d)
    step('temp-open')
    os.fchmod(fd, 0o600)
    data = base64.b64decode(cfg['data'], validate=True)
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        if count <= 0: raise RuntimeError('short write')
        view = view[count:]
    step('file-fsync')
    os.fsync(fd)
    temp_stat = os.fstat(fd)
    if not private_regular(temp_stat): raise RuntimeError('unsafe temp')
    os.close(fd); fd = -1
    expected = cfg['expected']
    try:
        current = os.stat(target, dir_fd=d, follow_symlinks=False)
        if expected is None: raise RuntimeError('target appeared')
        if not private_regular(current): raise RuntimeError('unsafe target')
        if (current.st_dev != int(expected['device']) or current.st_ino != int(expected['inode'])
            or current.st_ctime_ns != int(expected['changeTimeNs'])
            or current.st_mtime_ns != int(expected['modifyTimeNs'])):
            raise RuntimeError('target changed')
    except FileNotFoundError:
        if expected is not None: raise
    step('rename')
    os.rename(temp, target, src_dir_fd=d, dst_dir_fd=d)
    renamed = True
    current = os.stat(target, dir_fd=d, follow_symlinks=False)
    if not private_regular(current) or current.st_dev != temp_stat.st_dev or current.st_ino != temp_stat.st_ino:
        raise RuntimeError('rename mismatch')
    step('directory-fsync')
    os.fsync(d)
    print('OK', flush=True)
finally:
    if fd >= 0:
        try: os.close(fd)
        except OSError: pass
    if not renamed:
        try: os.unlink(temp, dir_fd=d)
        except FileNotFoundError: pass
`;

const PYTHON_LOCK_HELPER = String.raw`
import errno, fcntl, os, stat, sys, time
d = 3
name = sys.argv[1]
nofollow = os.O_NOFOLLOW if hasattr(os, 'O_NOFOLLOW') else 0
fd = -1
for attempt in range(20):
    try:
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | nofollow, 0o600, dir_fd=d)
        break
    except FileExistsError:
        try:
            fd = os.open(name, os.O_RDWR | nofollow, dir_fd=d)
            break
        except FileNotFoundError:
            pass
    except FileNotFoundError:
        pass
    time.sleep(0.005)
if fd < 0: raise RuntimeError('lock open failed')
os.fchmod(fd, 0o600)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or (st.st_mode & 0o777) != 0o600:
    raise RuntimeError('unsafe lock')
fcntl.flock(fd, fcntl.LOCK_EX)
print('LOCKED', flush=True)
if sys.stdin.readline().strip() != 'RELEASE':
    raise RuntimeError('invalid release')
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
`;

function stateError(): never {
  throw new Error('ERR_TASK_CARD_STATE');
}
