import { describe, expect, it } from 'vitest';

import {
  MR_IGNORE_ACTION,
  REPOSITORY_IGNORE_ACTION,
  TASK_ALLOW_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
  TASK_REJECT_ACTION,
  buildMrAttentionCard,
  buildTaskCandidateCard,
  buildTaskCompletionCard,
} from '../src/im/lark/task-action-card.js';

type Card = Record<string, any>;

function parse(card: string): Card {
  return JSON.parse(card);
}

function buttons(card: Card): any[] {
  return (card.body?.elements ?? []).flatMap((element: any) => {
    if (element.tag === 'button') return [element];
    if (element.tag === 'column_set') {
      return (element.columns ?? []).flatMap((column: any) =>
        (column.elements ?? []).filter((child: any) => child.tag === 'button'),
      );
    }
    return [];
  });
}

function callbackValue(button: any): Record<string, string> {
  return button.behaviors.find((behavior: any) => behavior.type === 'callback').value;
}

function actionMap(card: Card): Map<string, { label: string; value: Record<string, string> }> {
  return new Map(buttons(card).map((button) => {
    const value = callbackValue(button);
    return [value.action, { label: button.text.content, value }];
  }));
}

describe('task action cards', () => {
  it('builds a deterministic Lark v2 candidate card with allow, reject and discuss actions', () => {
    const input = {
      candidateId: 'candidate_01JZ8N9QG5',
      title: '修复结算页',
      summary: '来源于产品反馈',
      repositoryLabel: 'marketplace',
    };

    const first = buildTaskCandidateCard(input);
    const second = buildTaskCandidateCard({ ...input });
    expect(first).toBe(second);

    const card = parse(first);
    expect(card.schema).toBe('2.0');
    expect(card.config).toEqual({ update_multi: true });
    const actions = actionMap(card);
    expect([...actions.keys()]).toEqual([
      TASK_ALLOW_ACTION,
      TASK_REJECT_ACTION,
      TASK_DISCUSS_ACTION,
    ]);
    expect([...actions.values()].map((item) => item.label)).toEqual(['允许', '拒绝', '细聊']);
    for (const { value } of actions.values()) {
      expect(value).toEqual({ action: value.action, candidateId: input.candidateId });
    }
  });

  it('builds a completion card with only the feedback action', () => {
    const card = parse(buildTaskCompletionCard({
      candidateId: 'candidate_01JZ8N9QG5',
      title: '结算页修复完成',
      summary: '已完成测试并部署 PPE',
    }));

    const actions = actionMap(card);
    expect([...actions.keys()]).toEqual([TASK_FEEDBACK_ACTION]);
    expect(actions.get(TASK_FEEDBACK_ACTION)).toEqual({
      label: '阅读反馈',
      value: { action: TASK_FEEDBACK_ACTION, candidateId: 'candidate_01JZ8N9QG5' },
    });
  });

  it('builds an MR card with independently scoped MR and repository ignore actions', () => {
    const card = parse(buildMrAttentionCard({
      mrId: 'mr_23817',
      repositoryId: 'repo_marketplace',
      title: 'MR !23817 需要处理',
      summary: '流水线失败',
      repositoryLabel: 'marketplace',
    }));

    const actions = actionMap(card);
    expect([...actions.keys()]).toEqual([MR_IGNORE_ACTION, REPOSITORY_IGNORE_ACTION]);
    expect(actions.get(MR_IGNORE_ACTION)).toEqual({
      label: '不再关注此 MR',
      value: { action: MR_IGNORE_ACTION, mrId: 'mr_23817' },
    });
    expect(actions.get(REPOSITORY_IGNORE_ACTION)).toEqual({
      label: '不再关注此仓库',
      value: { action: REPOSITORY_IGNORE_ACTION, repositoryId: 'repo_marketplace' },
    });
  });

  it('keeps callback values opaque and excludes paths, source text, user identity and secrets', () => {
    const sensitive = {
      candidateId: 'candidate_opaque_7',
      title: '处理 OAuth 异常',
      summary: '原始需求正文 SECRET_BODY',
      repositoryLabel: 'agent-monorepo',
    };
    const card = parse(buildTaskCandidateCard(sensitive));

    const serializedValues = JSON.stringify(buttons(card).map(callbackValue));
    expect(serializedValues).toBe(JSON.stringify([
      { action: TASK_ALLOW_ACTION, candidateId: sensitive.candidateId },
      { action: TASK_REJECT_ACTION, candidateId: sensitive.candidateId },
      { action: TASK_DISCUSS_ACTION, candidateId: sensitive.candidateId },
    ]));
    expect(serializedValues).not.toMatch(/SECRET_BODY|agent-monorepo|chenliang|\/home\/|prompt|source|secret/i);
  });

  it('escapes display markdown and does not retain mutable caller data', () => {
    const input = {
      candidateId: 'candidate_detached',
      title: '标题 *bold* <at id=all></at>',
      summary: '正文 `code` [link](https://invalid.example)',
      repositoryLabel: 'repo_[prod]',
    };
    const cardText = buildTaskCandidateCard(input);
    input.title = 'mutated';
    input.summary = 'mutated';

    const card = parse(cardText);
    const display = JSON.stringify(card.body.elements);
    expect(display).toContain('\\\\*bold\\\\*');
    expect(display).toContain('&lt;at id=all&gt;&lt;/at&gt;');
    expect(display).toContain('\\\\`code\\\\`');
    expect(display).toContain('\\\\[link\\\\]');
    expect(display).not.toContain('mutated');
  });

  it.each([
    '',
    '../repo',
    '/home/chenliang.zy/Code/repo',
    'contains space',
    'line\nbreak',
    'x'.repeat(129),
  ])('rejects unsafe opaque identifier %j', (candidateId) => {
    expect(() => buildTaskCandidateCard({ candidateId, title: 'title', summary: 'summary' }))
      .toThrow(/candidateId/);
  });

  it('rejects invalid display text instead of emitting ambiguous card content', () => {
    expect(() => buildTaskCompletionCard({ candidateId: 'candidate_ok', title: 'x\u0000y', summary: 'ok' }))
      .toThrow(/title/);
  });
});
