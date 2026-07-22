import { chmodSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runTaskCardCommand } from '../src/cli/task-card.js';

const roots: string[] = [];
function fixture(mode = 0o600) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-task-card-cli-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const input = join(root, 'candidate.json');
  const envelope = {
    schemaVersion: 1, deliveryId: 'delivery_1', larkAppId: 'cli_task_bot', chatId: 'oc_tasks',
    card: { candidateId: 'candidate_1', title: 'SECRET TITLE', summary: 'SECRET BODY',
      source: 'SECRET SOURCE', recommendationReason: 'Reason', repositoryLabel: 'marketplace',
      risk: 'Low', validationMethod: 'Test' },
    candidate: { candidateId: 'candidate_1', repositoryId: 'marketplace', chatId: 'oc_tasks',
      prompt: 'SECRET PROMPT', sourceRef: 'lark:secret-source' },
  };
  writeFileSync(input, JSON.stringify(envelope), { mode });
  chmodSync(input, mode);
  return { root, input, envelope };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('task-card CLI', () => {
  it('accepts the exact command and emits metadata-only stdout', async () => {
    const { root, input } = fixture();
    const result = await runTaskCardCommand(['send', 'candidate', '--input-file', input], {
      stateDir: root,
      deliver: async () => ({ status: 'sent' }),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ success: true, kind: 'candidate', status: 'sent' });
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toMatch(/SECRET|prompt|source|chat|app|token|uuid|message/i);
  });

  it('rejects non-private, nested, symlinked, malformed and ambiguous input without leaking it', async () => {
    const publicFile = fixture(0o644);
    const nested = fixture();
    const nestedDir = join(nested.root, 'nested');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(nestedDir, { mode: 0o700 });
    const nestedFile = join(nestedDir, 'input.json');
    writeFileSync(nestedFile, JSON.stringify(nested.envelope), { mode: 0o600 });
    const linked = fixture();
    const link = join(linked.root, 'linked.json');
    symlinkSync(linked.input, link);
    const bad = fixture();
    writeFileSync(bad.input, '{"secret":"DO_NOT_LEAK"}', { mode: 0o600 });
    chmodSync(bad.input, 0o600);

    for (const [label, args, root] of [
      ['public', ['send', 'candidate', '--input-file', publicFile.input], publicFile.root],
      ['nested', ['send', 'candidate', '--input-file', nestedFile], nested.root],
      ['symlink', ['send', 'candidate', '--input-file', link], linked.root],
      ['malformed', ['send', 'candidate', '--input-file', bad.input], bad.root],
      ['extra', ['send', 'candidate', '--input-file', publicFile.input, '--extra'], publicFile.root],
    ]) {
      const result = await runTaskCardCommand(args, {
        stateDir: root,
        deliver: async () => ({ status: 'sent' }),
      });
      expect(result.code, String(label)).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^ERR_TASK_CARD_/);
      expect(result.stderr).not.toMatch(/DO_NOT_LEAK|SECRET/);
    }
  });
});
