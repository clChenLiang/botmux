import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { deliverTaskCard } from '../src/services/task-card-delivery.js';
import { createTaskCandidateRegistry } from '../src/services/task-candidate-registry.js';

const roots: string[] = [];
function stateDir() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-task-card-')));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function candidateEnvelope() {
  return {
    schemaVersion: 1,
    deliveryId: 'candidate-delivery-1',
    larkAppId: 'cli_task_bot',
    chatId: 'oc_tasks',
    card: {
      candidateId: 'candidate_1', title: 'Fix checkout', summary: 'Broken total',
      source: 'Lark', recommendationReason: 'User impact', repositoryLabel: 'marketplace',
      risk: 'Low', validationMethod: 'Regression and PPE',
    },
    candidate: {
      candidateId: 'candidate_1', repositoryId: 'marketplace', chatId: 'oc_tasks',
      prompt: 'Fix checkout using the source evidence', sourceRef: 'lark:om_source',
    },
  };
}

describe('task card delivery', () => {
  it('persists candidate before send, uses a stable UUID, binds root, and deduplicates', async () => {
    const root = stateDir();
    const registry = createTaskCandidateRegistry(join(root, 'task-candidates.json'));
    const calls: Array<{ uuid: string; content: string }> = [];
    const deps = {
      now: () => '2026-07-22T00:00:00.000Z',
      registerBot: async () => {},
      sendMessage: async (_app: string, _chat: string, content: string, _type: string, uuid: string) => {
        expect(await registry.resolve('candidate_1')).toMatchObject({ prompt: 'Fix checkout using the source evidence' });
        calls.push({ uuid, content });
        return 'om_candidate_card';
      },
    };
    expect(await deliverTaskCard(root, 'candidate', candidateEnvelope(), deps)).toEqual({ status: 'sent' });
    expect((await registry.resolve('candidate_1'))?.rootMessageId).toBe('om_candidate_card');
    expect(await deliverTaskCard(root, 'candidate', candidateEnvelope(), deps)).toEqual({ status: 'duplicate' });
    expect(calls).toHaveLength(1);
    expect(calls[0].uuid.length).toBeLessThanOrEqual(50);
    expect(calls[0].content).toContain('task_allow');
    expect(statSync(join(root, 'task-card-deliveries.json')).mode & 0o777).toBe(0o600);
  });

  it('retries an ambiguous failure with the same UUID and fails closed after one hour', async () => {
    const root = stateDir();
    let now = '2026-07-22T00:00:00.000Z';
    const uuids: string[] = [];
    let fail = true;
    const deps = {
      now: () => now,
      registerBot: async () => {},
      sendMessage: async (_a: string, _c: string, _body: string, _t: string, uuid: string) => {
        uuids.push(uuid);
        if (fail) throw new Error('ambiguous network failure with secret body');
        return 'om_retry';
      },
    };
    await expect(deliverTaskCard(root, 'candidate', candidateEnvelope(), deps)).rejects.toThrow(/ERR_TASK_CARD_SEND/);
    fail = false;
    now = '2026-07-22T00:30:00.000Z';
    expect(await deliverTaskCard(root, 'candidate', candidateEnvelope(), deps)).toEqual({ status: 'sent' });
    expect(uuids[0]).toBe(uuids[1]);

    const other = { ...candidateEnvelope(), deliveryId: 'candidate-delivery-stale',
      card: { ...candidateEnvelope().card, candidateId: 'candidate_stale' },
      candidate: { ...candidateEnvelope().candidate, candidateId: 'candidate_stale' } };
    fail = true;
    await expect(deliverTaskCard(root, 'candidate', other, deps)).rejects.toThrow(/ERR_TASK_CARD_SEND/);
    now = '2026-07-22T01:30:00.001Z';
    await expect(deliverTaskCard(root, 'candidate', other, deps)).rejects.toThrow(/ERR_TASK_CARD_UNCERTAIN/);
    expect(uuids).toHaveLength(3);
  });

  it('fails closed without resending when the clock moves behind attemptedAt', async () => {
    const root = stateDir();
    let now = '2026-07-22T00:00:00.000Z';
    let sends = 0;
    const deps = {
      now: () => now,
      registerBot: async () => {},
      sendMessage: async () => { sends += 1; throw new Error('ambiguous'); },
    };
    await expect(deliverTaskCard(root, 'candidate', candidateEnvelope(), deps))
      .rejects.toThrow(/ERR_TASK_CARD_SEND/);
    now = '2026-07-21T23:59:59.999Z';
    await expect(deliverTaskCard(root, 'candidate', candidateEnvelope(), deps))
      .rejects.toThrow(/ERR_TASK_CARD_UNCERTAIN/);
    expect(sends).toBe(1);
  });

  it('supports exact completion and MR contracts and rejects delivery id reuse', async () => {
    const root = stateDir();
    const bodies: string[] = [];
    const deps = {
      now: () => '2026-07-22T00:00:00.000Z', registerBot: async () => {},
      sendMessage: async (_a: string, _c: string, body: string) => { bodies.push(body); return `om_${bodies.length}`; },
    };
    const completion = {
      schemaVersion: 1, deliveryId: 'complete-1', larkAppId: 'cli_task_bot', chatId: 'oc_tasks',
      card: { candidateId: 'candidate_1', title: 'Done', environment: 'PPE China-North',
        prdUrl: 'https://example.test/prd', testReportUrl: 'https://example.test/test',
        mrUrl: 'https://example.test/mr', diffScreenshotUrl: 'https://example.test/diff',
        previewUrl: 'https://example.test/preview', ppeUrl: 'https://example.test/ppe' },
    };
    const mr = { schemaVersion: 1, deliveryId: 'mr-1', larkAppId: 'cli_task_bot', chatId: 'oc_tasks',
      card: { mrId: 'mr_opaque', repositoryId: 'repo_opaque', title: 'MR needs attention',
        summary: 'Checks failed', repositoryLabel: 'marketplace' } };
    expect(await deliverTaskCard(root, 'completion', completion, deps)).toEqual({ status: 'sent' });
    expect(await deliverTaskCard(root, 'mr', mr, deps)).toEqual({ status: 'sent' });
    expect(bodies[0]).toContain('task_feedback');
    expect(bodies[1]).toContain('task_ignore_repository');
    await expect(deliverTaskCard(root, 'completion', { ...completion, card: { ...completion.card, title: 'Changed' } }, deps))
      .rejects.toThrow(/ERR_TASK_CARD_CONFLICT/);
  });

  it('revalidates the pinned state directory before send and does not send after retarget', async () => {
    const root = stateDir();
    const moved = `${root}-moved`;
    roots.push(moved);
    let sends = 0;
    await expect(deliverTaskCard(root, 'candidate', candidateEnvelope(), {
      registerBot: async () => {
        renameSync(root, moved);
        mkdirSync(root, { mode: 0o700 });
      },
      sendMessage: async () => { sends += 1; return 'om_forbidden'; },
    })).rejects.toThrow(/ERR_TASK_CARD_STATE/);
    expect(sends).toBe(0);
  });

  it.each(['file-fsync', 'directory-fsync'] as const)(
    'does not send when durable candidate persistence fails at %s', async (failAt) => {
    const root = stateDir();
    let sends = 0;
    await expect(deliverTaskCard(root, 'candidate', candidateEnvelope(), {
      privateStateHooks: { failAt },
      registerBot: async () => {},
      sendMessage: async () => { sends += 1; return 'om_forbidden'; },
    })).rejects.toThrow(/ERR_TASK_CARD_STATE/);
    expect(sends).toBe(0);
  });

  it('does not send an MR when durable ledger directory fsync fails', async () => {
    const root = stateDir();
    let sends = 0;
    const mr = {
      schemaVersion: 1, deliveryId: 'mr-fsync', larkAppId: 'cli_task_bot', chatId: 'oc_tasks',
      card: { mrId: 'mr_opaque', repositoryId: 'repo_opaque', title: 'MR attention',
        summary: 'Checks failed', repositoryLabel: 'marketplace' },
    };
    await expect(deliverTaskCard(root, 'mr', mr, {
      privateStateHooks: { failAt: 'directory-fsync' },
      registerBot: async () => {},
      sendMessage: async () => { sends += 1; return 'om_forbidden'; },
    })).rejects.toThrow(/ERR_TASK_CARD_STATE/);
    expect(sends).toBe(0);
  });

  it('fails closed when the state directory is retargeted during send', async () => {
    const root = stateDir();
    const moved = `${root}-after-send`;
    roots.push(moved);
    let sends = 0;
    await expect(deliverTaskCard(root, 'candidate', candidateEnvelope(), {
      registerBot: async () => {},
      sendMessage: async () => {
        sends += 1;
        renameSync(root, moved);
        mkdirSync(root, { mode: 0o700 });
        return 'om_ambiguous';
      },
    })).rejects.toThrow(/ERR_TASK_CARD_STATE/);
    expect(sends).toBe(1);
  });

  it.each([
    ['uuid', 'tc_tampered'],
    ['attemptedAt', '2026-07-22 00:00:00Z'],
  ])('rejects a ledger with tampered %s', async (field, value) => {
    const root = stateDir();
    const deps = {
      now: () => '2026-07-22T00:00:00.000Z',
      registerBot: async () => {},
      sendMessage: async () => { throw new Error('leave attempting'); },
    };
    await expect(deliverTaskCard(root, 'candidate', candidateEnvelope(), deps))
      .rejects.toThrow(/ERR_TASK_CARD_SEND/);
    const path = join(root, 'task-card-deliveries.json');
    const state = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(path, 'utf8')));
    const key = Object.keys(state.deliveries)[0];
    state.deliveries[key][field] = value;
    const { writeFile, chmod } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(deliverTaskCard(root, 'candidate', candidateEnvelope(), {
      ...deps, sendMessage: async () => 'om_should_not_send',
    })).rejects.toThrow(/ERR_TASK_CARD_STATE/);
  });
});
