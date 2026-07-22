import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTaskCandidateRegistry } from '../src/services/task-candidate-registry.js';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-task-registry-'));
  chmodSync(root, 0o700);
  roots.push(root);
  const path = join(root, 'task-candidates.json');
  return { path, registry: createTaskCandidateRegistry(path) };
}

const candidate = (id: string) => ({
  candidateId: id,
  repositoryId: 'marketplace',
  chatId: 'oc_tasks',
  prompt: `Implement ${id}`,
  sourceRef: `lark:${id}`,
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('writable task candidate registry', () => {
  it('persists 0600 before resolve and binds the card root idempotently', async () => {
    const { path, registry } = fixture();
    expect(await registry.persist(candidate('candidate_1'))).toBe('created');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await registry.resolve('candidate_1')).toEqual(candidate('candidate_1'));
    expect(await registry.persist(candidate('candidate_1'))).toBe('duplicate');
    expect(await registry.bindRootMessage('candidate_1', 'om_card_1')).toBe('updated');
    expect(await registry.bindRootMessage('candidate_1', 'om_card_1')).toBe('duplicate');
    expect((await registry.resolve('candidate_1'))?.rootMessageId).toBe('om_card_1');
    await expect(registry.bindRootMessage('candidate_1', 'om_other')).rejects.toThrow(/conflict/);
  });

  it('serializes concurrent writers without losing candidates', async () => {
    const { path, registry } = fixture();
    const second = createTaskCandidateRegistry(path);
    await Promise.all([
      registry.persist(candidate('candidate_a')),
      second.persist(candidate('candidate_b')),
    ]);
    expect(await registry.resolve('candidate_a')).toEqual(candidate('candidate_a'));
    expect(await registry.resolve('candidate_b')).toEqual(candidate('candidate_b'));
  });

  it('fails closed for conflicts and corrupt state without prototype mutation', async () => {
    const { path, registry } = fixture();
    await registry.persist(candidate('__proto__'));
    expect((await registry.resolve('__proto__'))?.candidateId).toBe('__proto__');
    await expect(registry.persist({ ...candidate('__proto__'), prompt: 'changed' }))
      .rejects.toThrow(/conflict/);
    const { writeFile, chmod } = await import('node:fs/promises');
    await writeFile(path, '{bad', { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(registry.persist(candidate('candidate_c'))).rejects.toThrow(/invalid/);
    expect(readFileSync(path, 'utf8')).toBe('{bad');
  });
});
