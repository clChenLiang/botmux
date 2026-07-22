import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { deliverTaskCard } from '../src/services/task-card-delivery.js';
import { createTaskCandidateRegistry } from '../src/services/task-candidate-registry.js';

const roots: string[] = [];
function stateDir() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-task-card-'));
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
});
