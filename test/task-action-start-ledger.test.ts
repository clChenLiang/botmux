import { mkdtempSync, rmSync } from 'node:fs';
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
  return join(dir, 'starts.sqlite');
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
});
