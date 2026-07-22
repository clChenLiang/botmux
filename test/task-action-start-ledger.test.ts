import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTaskActionStartLedger } from '../src/services/task-action-start-ledger.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ledgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-task-start-ledger-'));
  dirs.push(dir);
  return join(realpathSync(dir), 'starts.sqlite');
}

describe('task action start ledger', () => {
  it('persists a completed start receipt across independent ledger instances', () => {
    const path = ledgerPath();
    const first = createTaskActionStartLedger(path);
    expect(first.inspect('action:abc')).toEqual({ state: 'absent' });
    expect(first.begin('action:abc', 'claim.one')).toEqual({ state: 'acquired' });
    first.complete('action:abc', 'claim.one', {
      sessionId: 'session_17', triggerId: 'trigger_17',
    });
    first.close();

    const reopened = createTaskActionStartLedger(path);
    expect(reopened.inspect('action:abc')).toEqual({
      state: 'started', sessionId: 'session_17', triggerId: 'trigger_17',
    });
    expect(reopened.begin('action:abc', 'claim.two')).toEqual({
      state: 'started', sessionId: 'session_17', triggerId: 'trigger_17',
    });
    reopened.close();
  });

  it('treats an interrupted starting intent as uncertain and never reacquires it', () => {
    const path = ledgerPath();
    const first = createTaskActionStartLedger(path);
    expect(first.begin('action:uncertain', 'claim.one')).toEqual({ state: 'acquired' });
    first.close();

    const reopened = createTaskActionStartLedger(path);
    expect(reopened.begin('action:uncertain', 'claim.two')).toEqual({ state: 'uncertain' });
    expect(() => reopened.complete('action:uncertain', 'claim.two', {
      sessionId: 'session_wrong', triggerId: 'trigger_wrong',
    })).toThrow(/claim/i);
    reopened.close();
  });

  it('stores only a token hash and keeps its directory and sqlite files owner-only', () => {
    const path = ledgerPath();
    const ledger = createTaskActionStartLedger(path);
    ledger.begin('action:private', 'claim.plaintext.secret');
    ledger.complete('action:private', 'claim.plaintext.secret', {
      sessionId: 'session_17', triggerId: 'trigger_17',
    });
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        expect(statSync(candidate).mode & 0o777).toBe(0o600);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    ledger.close();
    expect(readFileSync(path).includes(Buffer.from('claim.plaintext.secret'))).toBe(false);
  });

  it('rejects ledger and parent-directory symlinks', () => {
    const target = ledgerPath();
    writeFileSync(target, 'do-not-follow', { mode: 0o600 });
    const linkedFile = join(target, '..', 'linked.sqlite');
    symlinkSync(target, linkedFile);
    expect(() => createTaskActionStartLedger(linkedFile)).toThrow(/symlink|ledger path/i);
    expect(readFileSync(target, 'utf8')).toBe('do-not-follow');

    const realParent = mkdtempSync(join(tmpdir(), 'botmux-task-ledger-parent-'));
    dirs.push(realParent);
    const parentLink = join(realParent, '..', `linked-parent-${Date.now()}`);
    symlinkSync(realParent, parentLink, 'dir');
    try {
      expect(() => createTaskActionStartLedger(join(parentLink, 'starts.sqlite')))
        .toThrow(/canonical|symlink|directory/i);
    } finally {
      rmSync(parentLink);
    }
  });
});
