import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTaskCandidateRegistry } from '../src/services/task-candidate-registry.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function fixture(value: unknown) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'botmux-task-registry-')));
  dirs.push(dir);
  const path = join(dir, 'task-candidates.json');
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, registry: createTaskCandidateRegistry(path) };
}

describe('createTaskCandidateRegistry', () => {
  it('returns an exact authoritative candidate by opaque id', async () => {
    const record = {
      candidateId: 'candidate_17', repositoryId: 'marketplace', chatId: 'oc_tasks',
      rootMessageId: 'om_17', prompt: 'Do the task', sourceRef: 'lark://doc/17',
      originalSessionId: 'session_17',
    };
    const { registry } = await fixture({ schemaVersion: 1, candidates: { candidate_17: record } });
    await expect(registry.resolve('candidate_17')).resolves.toEqual(record);
    await expect(registry.resolve('candidate_missing')).resolves.toBeUndefined();
  });

  it.each([
    { schemaVersion: 2, candidates: {} },
    { schemaVersion: 1, candidates: [], extra: true },
    { schemaVersion: 1, candidates: { candidate_17: { candidateId: 'other' } } },
  ])('fails closed for malformed registry state %#', async (value) => {
    const { registry } = await fixture(value);
    await expect(registry.resolve('candidate_17')).rejects.toThrow('task candidate registry invalid');
  });

  it('rejects path-shaped lookup identifiers before reading state', async () => {
    const { registry } = await fixture({ schemaVersion: 1, candidates: {} });
    await expect(registry.resolve('../candidate')).rejects.toThrow('task candidate identifier invalid');
  });
});
