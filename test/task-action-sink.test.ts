import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTaskActionDispatchAcknowledger,
  createTaskActionSink,
  TaskActionSinkError,
} from '../src/services/task-action-sink.js';
import {
  MR_IGNORE_ACTION,
  REPOSITORY_IGNORE_ACTION,
  TASK_ALLOW_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_REJECT_ACTION,
} from '../src/im/lark/task-action-card.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function fixture(source: string, options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'botmux-task-sink-'));
  directories.push(directory);
  const cliPath = join(directory, 'task os cli;$(touch SHOULD_NOT_EXIST).mjs');
  const stateDir = join(directory, 'state dir;$(touch ALSO_NOT_HERE)');
  await writeFile(cliPath, source, { mode: 0o700 });
  const config = {
    nodeExecutable: process.execPath,
    taskOsCliPath: cliPath,
    stateDir,
    timeoutMs: options.timeoutMs ?? 2_000,
    maxOutputBytes: options.maxOutputBytes ?? 16_384,
  };
  const sink = createTaskActionSink(config);
  return { directory, cliPath, stateDir, config, sink };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  action: TASK_ALLOW_ACTION,
  subject: { type: 'candidate', id: 'candidate_17' },
  operatorOpenId: 'ou_owner_17',
  ...overrides,
} as any);

function responder(result: unknown, extra = ''): string {
  return `
    import { writeFileSync } from 'node:fs';
    ${extra}
    process.stdout.write(${JSON.stringify(JSON.stringify(result))});
  `;
}

describe('createTaskActionSink', () => {
  it('uses argv only, includes the exact transaction contract, and sanitizes inherited secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'botmux-task-sink-'));
    directories.push(directory);
    const capture = join(directory, 'capture.json');
    const cliPath = join(directory, 'task os cli;$(touch SHOULD_NOT_EXIST).mjs');
    const stateDir = join(directory, 'state dir;$(touch ALSO_NOT_HERE)');
    await writeFile(cliPath, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
      process.stdout.write(JSON.stringify({
        outcome: 'recorded', effectiveAction: 'task_allow',
        triggerRequired: true, idempotencyKey: 'delivery.candidate_01',
        dispatchToken: 'claim.candidate_01',
      }));
    `);
    process.env.BOTMUX_PRIVATE_ADAPTER_SECRET = 'DO_NOT_INHERIT_ME';
    try {
      const sink = createTaskActionSink({
        nodeExecutable: process.execPath,
        taskOsCliPath: cliPath,
        stateDir,
      });
      await expect(sink(request())).resolves.toEqual({
        outcome: 'recorded',
        effectiveAction: TASK_ALLOW_ACTION,
        triggerRequired: true,
        idempotencyKey: 'delivery.candidate_01',
        dispatchToken: 'claim.candidate_01',
      });
    } finally {
      delete process.env.BOTMUX_PRIVATE_ADAPTER_SECRET;
    }

    const captured = JSON.parse(await readFile(capture, 'utf8'));
    expect(captured.argv).toEqual([
      'task-action', 'apply',
      '--state-dir', stateDir,
      '--action', TASK_ALLOW_ACTION,
      '--subject-type', 'candidate',
      '--subject-id', 'candidate_17',
      '--operator-open-id', 'ou_owner_17',
      '--json',
    ]);
    expect(captured.env.BOTMUX_PRIVATE_ADAPTER_SECRET).toBeUndefined();
    expect(captured.env).toMatchObject({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
    expect(captured.env.PATH).toBe(dirname(process.execPath));
    await expect(readFile(join(directory, 'SHOULD_NOT_EXIST'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(directory, 'PWNED'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [{ outcome: 'recorded', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: true, idempotencyKey: 'delivery.c1', dispatchToken: 'claim.c1' }],
    [{ outcome: 'duplicate', effectiveAction: TASK_DISCUSS_ACTION, triggerRequired: true, idempotencyKey: 'delivery.c2', dispatchToken: 'claim.c2' }],
    [{ outcome: 'duplicate', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: false }],
    [{ outcome: 'conflict', effectiveAction: TASK_REJECT_ACTION, triggerRequired: false }],
    [{ outcome: 'recorded', effectiveAction: MR_IGNORE_ACTION, triggerRequired: false }],
    [{ outcome: 'recorded', effectiveAction: REPOSITORY_IGNORE_ACTION, triggerRequired: false }],
  ] as const)('maps an exact durable result %j', async (result) => {
    const { sink } = await fixture(responder(result));
    const action = result.outcome === 'conflict' ? TASK_ALLOW_ACTION : result.effectiveAction;
    const subject = action === MR_IGNORE_ACTION
      ? { type: 'mr', id: 'mr_17' }
      : action === REPOSITORY_IGNORE_ACTION
        ? { type: 'repository', id: 'repo_marketplace' }
        : { type: 'candidate', id: 'candidate_17' };
    await expect(sink(request({ action, subject }))).resolves.toEqual(result);
  });

  it.each([
    ['', 'empty stdout'],
    ['not-json PRIVATE_STDOUT', 'malformed JSON'],
    ['{}', 'missing fields'],
    [JSON.stringify({ outcome: 'recorded', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: false, extra: true }), 'extra field'],
    [JSON.stringify({ outcome: 'recorded', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: true, dispatchToken: 'claim.c1' }), 'missing key'],
    [JSON.stringify({ outcome: 'recorded', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: true, idempotencyKey: 'delivery.c1' }), 'missing dispatch token'],
    [JSON.stringify({ outcome: 'recorded', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: false, idempotencyKey: 'x' }), 'unexpected key'],
    [JSON.stringify({ outcome: 'recorded', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: false, dispatchToken: 'claim.c1' }), 'unexpected token'],
    [JSON.stringify({ outcome: 'recorded', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: true, idempotencyKey: '../unsafe', dispatchToken: 'claim.c1' }), 'unsafe key'],
    [JSON.stringify({ outcome: 'recorded', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: true, idempotencyKey: 'delivery.c1', dispatchToken: '../unsafe' }), 'unsafe dispatch token'],
    [JSON.stringify({ outcome: 'recorded', effectiveAction: MR_IGNORE_ACTION, triggerRequired: true, idempotencyKey: 'delivery.mr', dispatchToken: 'claim.mr' }), 'invalid trigger action'],
  ])('rejects %s protocol output without echoing private content (%s)', async (stdout) => {
    const { sink } = await fixture(`process.stdout.write(${JSON.stringify(stdout)});`);
    const error = await sink(request()).catch((caught) => caught);
    expect(error).toBeInstanceOf(TaskActionSinkError);
    expect(error).toMatchObject({ code: 'ERR_TASK_ACTION_SINK_PROTOCOL' });
    expect(String(error)).not.toContain('PRIVATE_STDOUT');
  });

  it('rejects a nonzero exit and redacts stdout, stderr, and exit details', async () => {
    const { sink } = await fixture(`
      process.stdout.write('PRIVATE_STDOUT');
      process.stderr.write('PRIVATE_STDERR');
      process.exit(37);
    `);
    const error = await sink(request()).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'ERR_TASK_ACTION_SINK_EXIT' });
    expect(String(error)).not.toMatch(/PRIVATE|37/);
  });

  it('bounds aggregate output and returns a stable redacted error', async () => {
    const { sink } = await fixture(`
      process.stdout.write('PRIVATE_OUTPUT'.repeat(200));
      setInterval(() => {}, 1_000);
    `, { maxOutputBytes: 128 });
    const error = await sink(request()).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'ERR_TASK_ACTION_SINK_OUTPUT' });
    expect(String(error)).not.toContain('PRIVATE_OUTPUT');
  });

  it.each(['timeout', 'output'] as const)(
    'settles a %s failure after the kill grace when a child never closes',
    async (failure) => {
      const child = stubbornChild();
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const stubbornSink = createTaskActionSink({
        nodeExecutable: process.execPath,
        taskOsCliPath: join(process.cwd(), 'fake-cli.mjs'),
        stateDir: join(process.cwd(), 'fake-state'),
        timeoutMs: failure === 'timeout' ? 10 : 2_000,
        maxOutputBytes: 16,
      }, {
        spawn: () => child as ChildProcess,
        killProcess: (_pid, signal) => {
          signals.push(signal);
          throw new Error('PRIVATE UNINTERRUPTIBLE PROCESS');
        },
        platform: 'linux',
      });
      let settlements = 0;
      const result = stubbornSink(request()).then(
        () => { settlements += 1; return undefined; },
        (error) => { settlements += 1; return error; },
      );
      if (failure === 'output') child.stdout.write('PRIVATE_OUTPUT_OVERFLOW');

      const error = await result;
      expect(error).toMatchObject({
        code: failure === 'timeout'
          ? 'ERR_TASK_ACTION_SINK_TIMEOUT'
          : 'ERR_TASK_ACTION_SINK_OUTPUT',
      });
      expect(String(error)).not.toContain('PRIVATE');
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.stderr.listenerCount('data')).toBe(0);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);

      child.emit('error', new Error('PRIVATE LATE ERROR'));
      child.emit('close', null, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settlements).toBe(1);
    },
  );

  it('times out, kills the detached process group, and does not leak output', async () => {
    const { directory, sink } = await fixture('setInterval(() => {}, 1_000);', { timeoutMs: 50 });
    const marker = join(directory, 'started');
    const pidFile = join(directory, 'child.pid');
    await writeFile(join(directory, 'task os cli;$(touch SHOULD_NOT_EXIST).mjs'), `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      writeFileSync(${JSON.stringify(marker)}, 'yes');
      process.stderr.write('PRIVATE_TIMEOUT');
      setInterval(() => {}, 1_000);
    `);
    const error = await sink(request()).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'ERR_TASK_ACTION_SINK_TIMEOUT' });
    expect(String(error)).not.toContain('PRIVATE_TIMEOUT');
    expect(await readFile(marker, 'utf8')).toBe('yes');
    const childPid = Number(await readFile(pidFile, 'utf8'));
    await expect(waitForProcessExit(childPid)).resolves.toBeUndefined();
  });

  it('cancels the escalation timer once a timed-out child has closed', async () => {
    const { sink } = await fixture('setInterval(() => {}, 1_000);', { timeoutMs: 20 });
    const originalKill = process.kill.bind(process);
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0) signals.push(signal);
      return originalKill(pid, signal as NodeJS.Signals | number | undefined);
    }) as typeof process.kill;
    try {
      await expect(sink(request())).rejects.toMatchObject({
        code: 'ERR_TASK_ACTION_SINK_TIMEOUT',
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(signals).toEqual(['SIGTERM']);
    } finally {
      process.kill = originalKill;
    }
  });

  it('maps spawn failures to a stable private error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'botmux-task-sink-'));
    directories.push(directory);
    const sink = createTaskActionSink({
      nodeExecutable: join(directory, 'missing-node'),
      taskOsCliPath: join(directory, 'missing-cli.mjs'),
      stateDir: join(directory, 'state'),
    });
    const error = await sink(request()).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'ERR_TASK_ACTION_SINK_SPAWN' });
    expect(String(error)).not.toContain(directory);
  });

  describe('createTaskActionDispatchAcknowledger', () => {
    it('invokes the exact fenced acknowledgement argv with the sanitized environment', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'botmux-task-ack-'));
      directories.push(directory);
      const capture = join(directory, 'capture.json');
      const cliPath = join(directory, 'task os ack cli;$(touch ACK_PWNED).mjs');
      const stateDir = join(directory, 'ack state;$(touch ACK_STATE_PWNED)');
      await writeFile(cliPath, `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
        process.stdout.write(JSON.stringify({ outcome: 'dispatched', idempotencyKey: 'delivery.c1' }));
      `);
      process.env.BOTMUX_PRIVATE_ACK_SECRET = 'DO_NOT_INHERIT_ACK';
      try {
        const acknowledge = createTaskActionDispatchAcknowledger({
          nodeExecutable: process.execPath,
          taskOsCliPath: cliPath,
          stateDir,
        });
        await expect(acknowledge({
          idempotencyKey: 'delivery.c1',
          dispatchToken: 'claim.c1',
        })).resolves.toEqual({ outcome: 'dispatched', idempotencyKey: 'delivery.c1' });
      } finally {
        delete process.env.BOTMUX_PRIVATE_ACK_SECRET;
      }
      const captured = JSON.parse(await readFile(capture, 'utf8'));
      expect(captured.argv).toEqual([
        'task-action', 'dispatched',
        '--state-dir', stateDir,
        '--idempotency-key', 'delivery.c1',
        '--dispatch-token', 'claim.c1',
        '--json',
      ]);
      expect(captured.env.BOTMUX_PRIVATE_ACK_SECRET).toBeUndefined();
      expect(captured.env).toMatchObject({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
    });

    it.each(['dispatched', 'duplicate'] as const)('accepts a matching %s result', async (outcome) => {
      const { config } = await fixture(responder({ outcome, idempotencyKey: 'delivery.c1' }));
      const acknowledge = createTaskActionDispatchAcknowledger(config);
      await expect(acknowledge({
        idempotencyKey: 'delivery.c1', dispatchToken: 'claim.c1',
      })).resolves.toEqual({ outcome, idempotencyKey: 'delivery.c1' });
    });

    it.each([
      '',
      'PRIVATE_ACK_NOT_JSON',
      JSON.stringify({ outcome: 'unknown', idempotencyKey: 'delivery.c1' }),
      JSON.stringify({ outcome: 'dispatched', idempotencyKey: 'delivery.other' }),
      JSON.stringify({ outcome: 'dispatched', idempotencyKey: 'delivery.c1', extra: true }),
      JSON.stringify({ outcome: 'dispatched', idempotencyKey: '../unsafe' }),
    ])('rejects hostile or malformed acknowledgement output', async (stdout) => {
      const { config } = await fixture(`process.stdout.write(${JSON.stringify(stdout)});`);
      const acknowledge = createTaskActionDispatchAcknowledger(config);
      const error = await acknowledge({
        idempotencyKey: 'delivery.c1', dispatchToken: 'claim.c1',
      }).catch((caught) => caught);
      expect(error).toMatchObject({ code: 'ERR_TASK_ACTION_SINK_PROTOCOL' });
      expect(String(error)).not.toContain('PRIVATE_ACK');
    });

    it.each([
      [{ idempotencyKey: 'delivery.c1' }, 'missing token'],
      [{ idempotencyKey: '../unsafe', dispatchToken: 'claim.c1' }, 'unsafe key'],
      [{ idempotencyKey: 'delivery.c1', dispatchToken: '../unsafe' }, 'unsafe token'],
      [{ idempotencyKey: 'delivery.c1', dispatchToken: 'claim.c1', extra: true }, 'extra'],
      [Object.defineProperty({}, 'dispatchToken', { get() { throw new Error('PRIVATE_ACK_GETTER'); } }), 'accessor'],
      [new Proxy({}, { ownKeys() { throw new Error('PRIVATE_ACK_PROXY'); } }), 'proxy'],
    ])('rejects hostile acknowledgement input', async (input) => {
      const { config } = await fixture(responder({ outcome: 'dispatched', idempotencyKey: 'delivery.c1' }));
      const acknowledge = createTaskActionDispatchAcknowledger(config);
      const error = await acknowledge(input as any).catch((caught) => caught);
      expect(error).toMatchObject({ code: 'ERR_TASK_ACTION_SINK_INPUT' });
      expect(String(error)).not.toContain('PRIVATE_ACK');
    });

    it.each(['timeout', 'output'] as const)('reuses bounded %s process handling', async (failure) => {
      const source = failure === 'timeout'
        ? 'setInterval(() => {}, 1_000);'
        : "process.stdout.write('PRIVATE_ACK_OUTPUT'.repeat(200)); setInterval(() => {}, 1_000);";
      const { config } = await fixture(source, {
        timeoutMs: failure === 'timeout' ? 20 : 2_000,
        maxOutputBytes: 64,
      });
      const acknowledge = createTaskActionDispatchAcknowledger(config);
      const error = await acknowledge({
        idempotencyKey: 'delivery.c1', dispatchToken: 'claim.c1',
      }).catch((caught) => caught);
      expect(error).toMatchObject({
        code: failure === 'timeout'
          ? 'ERR_TASK_ACTION_SINK_TIMEOUT'
          : 'ERR_TASK_ACTION_SINK_OUTPUT',
      });
      expect(String(error)).not.toContain('PRIVATE_ACK_OUTPUT');
    });
  });

  it.each([
    [{ nodeExecutable: 'node', taskOsCliPath: '/cli.mjs', stateDir: '/state' }, 'relative executable'],
    [{ nodeExecutable: process.execPath, taskOsCliPath: 'cli.mjs', stateDir: '/state' }, 'relative CLI'],
    [{ nodeExecutable: process.execPath, taskOsCliPath: '/cli.mjs', stateDir: 'state' }, 'relative state'],
    [{ nodeExecutable: process.execPath, taskOsCliPath: '/cli.mjs', stateDir: '/state', extra: true }, 'extra key'],
    [Object.defineProperty({}, 'nodeExecutable', { get() { throw new Error('PRIVATE_GETTER'); } }), 'accessor'],
    [new Proxy({}, { ownKeys() { throw new Error('PRIVATE_PROXY'); } }), 'proxy'],
  ])('rejects an unsafe configuration', (config) => {
    expect(() => createTaskActionSink(config as any)).toThrowError(TaskActionSinkError);
    try {
      createTaskActionSink(config as any);
    } catch (error) {
      expect(error).toMatchObject({ code: 'ERR_TASK_ACTION_SINK_CONFIG' });
      expect(String(error)).not.toMatch(/PRIVATE|nodeExecutable|taskOsCliPath/);
    }
  });

  it.each([
    [{ ...request(), extra: true }, 'extra request key'],
    [{ ...request(), subject: { type: 'candidate', id: 'c1', extra: true } }, 'extra subject key'],
    [Object.defineProperty({}, 'action', { get() { throw new Error('PRIVATE_REQUEST'); } }), 'accessor request'],
    [new Proxy({}, { ownKeys() { throw new Error('PRIVATE_REQUEST_PROXY'); } }), 'proxy request'],
    [request({ action: MR_IGNORE_ACTION, subject: { type: 'candidate', id: 'c1' } }), 'action/subject mismatch'],
  ])('rejects unsafe input', async (input) => {
    const { sink } = await fixture(responder({
      outcome: 'recorded', effectiveAction: TASK_ALLOW_ACTION, triggerRequired: false,
    }));
    const error = await sink(input as any).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'ERR_TASK_ACTION_SINK_INPUT' });
    expect(String(error)).not.toContain('PRIVATE_REQUEST');
  });
});

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('child process group member remained alive');
}

function stubbornChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    killSignals: Array<NodeJS.Signals | number | undefined>;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };
  child.pid = 424_242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return false;
  };
  return child;
}
