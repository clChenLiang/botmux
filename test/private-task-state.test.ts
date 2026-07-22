import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  durablePrivateWrite,
  pinPrivateStateDirectory,
  readPrivateFile,
  type PrivateStateHooks,
} from '../src/services/private-task-state.js';

const roots: string[] = [];

function privateDir(prefix = 'botmux-private-state-'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('private task state primitives', () => {
  it('rejects any parent symlink and detects a retargeted pinned directory', async () => {
    const target = privateDir();
    const link = join(dirname(target), `task-state-link-${process.pid}-${Date.now()}`);
    symlinkSync(target, link, 'dir');
    roots.push(link);
    await expect(pinPrivateStateDirectory(link)).rejects.toThrow(/ERR_TASK_CARD_STATE/);

    const realParent = privateDir('botmux-private-parent-');
    const nested = join(realParent, 'nested');
    mkdirSync(nested, { mode: 0o700 });
    const parentLink = join(dirname(realParent), `task-parent-link-${process.pid}-${Date.now()}`);
    symlinkSync(realParent, parentLink, 'dir');
    roots.push(parentLink);
    await expect(pinPrivateStateDirectory(join(parentLink, 'nested')))
      .rejects.toThrow(/ERR_TASK_CARD_STATE/);

    const guard = await pinPrivateStateDirectory(target);
    const moved = `${target}-moved`;
    renameSync(target, moved);
    roots.push(moved);
    mkdirSync(target, { mode: 0o700 });
    await expect(guard.revalidate()).rejects.toThrow(/ERR_TASK_CARD_STATE/);
    await guard.close();
  });

  it('writes durably in file-fsync/rename/directory-fsync order and fails closed', async () => {
    const root = privateDir();
    const guard = await pinPrivateStateDirectory(root);
    const path = join(root, 'state.json');
    const steps: string[] = [];
    await durablePrivateWrite(path, '{"ok":true}', guard, {
      onStep: (step) => { steps.push(step); },
    });
    expect(steps).toEqual(['temp-open', 'file-fsync', 'rename', 'directory-fsync']);
    expect(readFileSync(path, 'utf8')).toBe('{"ok":true}');

    const failed = join(root, 'failed.json');
    const hooks: PrivateStateHooks = {
      failAt: 'file-fsync',
    };
    await expect(durablePrivateWrite(failed, 'secret', guard, hooks))
      .rejects.toThrow(/ERR_TASK_CARD_STATE/);
    expect(existsSync(failed)).toBe(false);
    await guard.close();
  });

  it('rejects a private file whose path is replaced after O_NOFOLLOW open', async () => {
    const root = privateDir();
    const path = join(root, 'state.json');
    const original = join(root, 'original.json');
    writeFileSync(path, '{"version":1}', { mode: 0o600 });
    chmodSync(path, 0o600);
    const guard = await pinPrivateStateDirectory(root);
    await expect(readPrivateFile(path, 1024, false, guard, {
      afterReadOpen: () => {
        renameSync(path, original);
        writeFileSync(path, '{"version":2}', { mode: 0o600 });
        chmodSync(path, 0o600);
      },
    })).rejects.toThrow(/ERR_TASK_CARD_STATE/);
    await guard.close();
  });

  it('does not overwrite either namespace when the parent is retargeted before rename', async () => {
    const root = privateDir();
    const path = join(root, 'state.json');
    writeFileSync(path, 'ORIGINAL', { mode: 0o600 });
    chmodSync(path, 0o600);
    const guard = await pinPrivateStateDirectory(root);
    const moved = `${root}-pre-rename`;
    roots.push(moved);
    await expect(durablePrivateWrite(path, 'NEW-DATA', guard, {
      beforeRename: () => {
        renameSync(root, moved);
        mkdirSync(root, { mode: 0o700 });
        writeFileSync(path, 'REPLACE!', { mode: 0o600 });
        chmodSync(path, 0o600);
      },
    })).rejects.toThrow(/ERR_TASK_CARD_STATE/);
    expect(readFileSync(join(moved, 'state.json'), 'utf8')).toBe('ORIGINAL');
    expect(readFileSync(path, 'utf8')).toBe('REPLACE!');
    expect(readdirSync(moved).some((name) => name.endsWith('.tmp'))).toBe(false);
    await guard.close();
  });

  it('rejects same-inode same-size in-place changes while reading', async () => {
    const root = privateDir();
    const path = join(root, 'state.json');
    writeFileSync(path, '{"version":1}', { mode: 0o600 });
    chmodSync(path, 0o600);
    const guard = await pinPrivateStateDirectory(root);
    await expect(readPrivateFile(path, 1024, false, guard, {
      afterReadOpen: () => { writeFileSync(path, '{"version":2}'); },
    })).rejects.toThrow(/ERR_TASK_CARD_STATE/);
    await guard.close();
  });

  it('rejects same-inode same-size changes between reading and replacing state', async () => {
    const root = privateDir();
    const path = join(root, 'state.json');
    writeFileSync(path, '{"version":1}', { mode: 0o600 });
    chmodSync(path, 0o600);
    const guard = await pinPrivateStateDirectory(root);
    const snapshot = await readPrivateFile(path, 1024, false, guard);
    writeFileSync(path, '{"version":2}');
    await expect(durablePrivateWrite(path, '{"version":3}', guard, {}, snapshot))
      .rejects.toThrow(/ERR_TASK_CARD_STATE/);
    expect(readFileSync(path, 'utf8')).toBe('{"version":2}');
    await guard.close();
  });
});
