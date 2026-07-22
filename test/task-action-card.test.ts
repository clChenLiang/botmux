import { describe, expect, it } from 'vitest';

import {
  MR_IGNORE_ACTION,
  MR_KEEP_WATCHING_ACTION,
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

const CANDIDATE = {
  candidateId: 'candidate_01JZ8N9QG5',
  title: '修复结算页',
  summary: '购买完成后页面展示错误。',
  source: '飞书产品反馈群',
  recommendationReason: '影响核心支付链路，且修复范围明确。',
  repositoryLabel: 'marketplace',
  risk: '可能影响旧订单回显。',
  validationMethod: '运行结算回归测试，并在 PPE 验证新旧订单。',
};

const COMPLETION = {
  candidateId: CANDIDATE.candidateId,
  title: '结算页修复完成',
  environment: 'PPE · China-North · marketplace',
  prdUrl: 'https://bytedance.larkoffice.com/docx/prd_1',
  testReportUrl: 'https://bytedance.larkoffice.com/docx/test_1',
  mrUrl: 'https://code.byted.org/group/repo/merge_requests/17',
  diffScreenshotUrl: 'https://bytedance.larkoffice.com/file/diff_1',
  previewUrl: 'https://preview.example.com/build/17',
  ppeUrl: 'https://ppe.example.com/build/17',
};

const MR = {
  mrId: 'mr_23817',
  repositoryId: 'repo_marketplace',
  title: 'MR !23817 需要处理',
  summary: '流水线失败',
  repositoryLabel: 'marketplace',
};

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

function markdown(card: Card): string[] {
  return card.body.elements.filter((element: any) => element.tag === 'markdown')
    .map((element: any) => element.content);
}

describe('task action cards', () => {
  it('renders every required candidate field and the three decision actions', () => {
    const first = buildTaskCandidateCard(CANDIDATE);
    expect(first).toBe(buildTaskCandidateCard({ ...CANDIDATE }));

    const card = parse(first);
    expect(card.schema).toBe('2.0');
    expect(card.config).toEqual({ update_multi: true });
    expect(markdown(card)).toEqual([
      '**标题**\n修复结算页',
      '**摘要**\n购买完成后页面展示错误。',
      '**来源**\n飞书产品反馈群',
      '**推荐理由**\n影响核心支付链路，且修复范围明确。',
      '**仓库**\nmarketplace',
      '**风险**\n可能影响旧订单回显。',
      '**预估验证方式**\n运行结算回归测试，并在 PPE 验证新旧订单。',
    ]);

    const actions = actionMap(card);
    expect([...actions.keys()]).toEqual([TASK_ALLOW_ACTION, TASK_REJECT_ACTION, TASK_DISCUSS_ACTION]);
    expect([...actions.values()].map((item) => item.label)).toEqual(['允许', '拒绝', '细聊']);
    for (const { value } of actions.values()) {
      expect(value).toEqual({ action: value.action, candidateId: CANDIDATE.candidateId });
    }
  });

  it('requires every structured candidate field', () => {
    for (const field of ['candidateId', 'title', 'summary', 'source', 'recommendationReason', 'repositoryLabel', 'risk', 'validationMethod']) {
      const input = { ...CANDIDATE } as Record<string, unknown>;
      delete input[field];
      expect(() => buildTaskCandidateCard(input as any), field).toThrow(new RegExp(field));
    }
  });

  it('renders all completion evidence as labeled active HTTPS links and one-line environment', () => {
    const card = parse(buildTaskCompletionCard(COMPLETION));
    expect(markdown(card)).toEqual([
      '**标题**\n结算页修复完成',
      '**运行环境**\nPPE · China-North · marketplace',
      '**交付材料**',
      '[产品需求](https://bytedance.larkoffice.com/docx/prd_1)',
      '[测试报告](https://bytedance.larkoffice.com/docx/test_1)',
      '[MR](https://code.byted.org/group/repo/merge_requests/17)',
      '[diff 截图](https://bytedance.larkoffice.com/file/diff_1)',
      '[Preview](https://preview.example.com/build/17)',
      '[PPE](https://ppe.example.com/build/17)',
    ]);
    const actions = actionMap(card);
    expect([...actions.keys()]).toEqual([TASK_FEEDBACK_ACTION]);
    expect(actions.get(TASK_FEEDBACK_ACTION)).toEqual({
      label: '阅读反馈',
      value: { action: TASK_FEEDBACK_ACTION, candidateId: CANDIDATE.candidateId },
    });
    expect(JSON.stringify([...actions.values()])).not.toContain('https://');
  });

  it('requires every completion link and runtime environment', () => {
    for (const field of ['candidateId', 'title', 'environment', 'prdUrl', 'testReportUrl', 'mrUrl', 'diffScreenshotUrl', 'previewUrl', 'ppeUrl']) {
      const input = { ...COMPLETION } as Record<string, unknown>;
      delete input[field];
      expect(() => buildTaskCompletionCard(input as any), field).toThrow(new RegExp(field));
    }
  });

  it('rejects non-HTTPS, credential-bearing and markdown-shaped completion URLs', () => {
    for (const prdUrl of [
      'http://example.com/prd',
      'javascript:alert(1)',
      'https://user:secret@example.com/prd',
      '[fake](https://evil.example/prd)',
      'https://example.com/prd\n[evil](https://evil.example)',
      'https://example.com/\u202Efdp.exe',
    ]) {
      expect(() => buildTaskCompletionCard({ ...COMPLETION, prdUrl }), prdUrl).toThrow(/prdUrl/);
    }
  });

  it('percent-encodes markdown delimiters in otherwise valid HTTPS URLs', () => {
    const card = parse(buildTaskCompletionCard({
      ...COMPLETION,
      diffScreenshotUrl: 'https://files.example.com/diff_(17).png',
    }));
    expect(markdown(card)).toContain('[diff 截图](https://files.example.com/diff_%2817%29.png)');
  });

  it('renders continue watching before independently scoped MR and repository ignore actions', () => {
    const actions = actionMap(parse(buildMrAttentionCard(MR)));
    expect([...actions.keys()]).toEqual([
      MR_KEEP_WATCHING_ACTION,
      MR_IGNORE_ACTION,
      REPOSITORY_IGNORE_ACTION,
    ]);
    expect([...actions.values()].map((item) => item.label)).toEqual([
      '继续关注',
      '不再关注此 MR',
      '不再关注此仓库',
    ]);
    expect(actions.get(MR_KEEP_WATCHING_ACTION)?.value).toEqual({
      action: MR_KEEP_WATCHING_ACTION,
      mrId: MR.mrId,
    });
    expect(actions.get(MR_IGNORE_ACTION)?.value).toEqual({ action: MR_IGNORE_ACTION, mrId: MR.mrId });
    expect(actions.get(REPOSITORY_IGNORE_ACTION)?.value).toEqual({
      action: REPOSITORY_IGNORE_ACTION,
      repositoryId: MR.repositoryId,
    });
  });

  it('requires every MR card field', () => {
    for (const field of ['mrId', 'repositoryId', 'title', 'summary', 'repositoryLabel']) {
      const input = { ...MR } as Record<string, unknown>;
      delete input[field];
      expect(() => buildMrAttentionCard(input as any), field).toThrow(new RegExp(field));
    }
  });

  it('keeps callback values opaque and excludes content, paths, user identity and secrets', () => {
    const values = buttons(parse(buildTaskCandidateCard({
      ...CANDIDATE,
      summary: 'SECRET_BODY /home/chenliang.zy/Code/marketplace',
    }))).map(callbackValue);
    expect(values).toEqual([
      { action: TASK_ALLOW_ACTION, candidateId: CANDIDATE.candidateId },
      { action: TASK_REJECT_ACTION, candidateId: CANDIDATE.candidateId },
      { action: TASK_DISCUSS_ACTION, candidateId: CANDIDATE.candidateId },
    ]);
    expect(JSON.stringify(values)).not.toMatch(/SECRET_BODY|marketplace|chenliang|\/home\/|prompt|source|secret/i);
  });

  it('escapes multiline display markdown and returns data detached from caller input', () => {
    const input = {
      ...CANDIDATE,
      summary: '正文 `code`\n[link](https://invalid.example)',
      recommendationReason: '优先级 *high*',
    };
    const cardText = buildTaskCandidateCard(input);
    input.summary = 'mutated';
    const display = JSON.stringify(parse(cardText).body.elements);
    expect(display).toContain('\\\\`code\\\\`');
    expect(display).toContain('\\\\[link\\\\]');
    expect(display).toContain('\\\\*high\\\\*');
    expect(display).not.toContain('mutated');
  });

  it.each(['', '../repo', '/home/user/repo', 'contains space', 'line\nbreak', 'x'.repeat(129)])(
    'rejects unsafe opaque identifier %j',
    (candidateId) => {
      expect(() => buildTaskCandidateCard({ ...CANDIDATE, candidateId })).toThrow(/candidateId/);
    },
  );

  it.each(['title', 'source', 'repositoryLabel'] as const)(
    'rejects multiline and invisible formatting in single-line candidate field %s',
    (field) => {
      expect(() => buildTaskCandidateCard({ ...CANDIDATE, [field]: 'safe\nspoofed' })).toThrow(new RegExp(field));
      expect(() => buildTaskCandidateCard({ ...CANDIDATE, [field]: 'safe\tspoofed' })).toThrow(new RegExp(field));
      expect(() => buildTaskCandidateCard({ ...CANDIDATE, [field]: 'safe\u200Bspoofed' })).toThrow(new RegExp(field));
    },
  );

  it('rejects multiline or invisible formatting in completion labels and environment', () => {
    expect(() => buildTaskCompletionCard({ ...COMPLETION, title: 'done\rspoofed' })).toThrow(/title/);
    expect(() => buildTaskCompletionCard({ ...COMPLETION, environment: 'PPE\u2060spoofed' })).toThrow(/environment/);
  });

  it.each([
    ['NEXT LINE', '\u0085'],
    ['LINE SEPARATOR', '\u2028'],
    ['PARAGRAPH SEPARATOR', '\u2029'],
    ['ZERO WIDTH SPACE', '\u200B'],
    ['WORD JOINER', '\u2060'],
    ['ZERO WIDTH NO-BREAK SPACE', '\uFEFF'],
  ])('rejects Unicode %s in title and environment', (_name, character) => {
    expect(() => buildTaskCandidateCard({ ...CANDIDATE, title: `safe${character}spoofed` }))
      .toThrow(/title/);
    expect(() => buildTaskCompletionCard({ ...COMPLETION, environment: `safe${character}spoofed` }))
      .toThrow(/environment/);
  });

  it.each(['summary', 'recommendationReason', 'risk', 'validationMethod'] as const)(
    'allows multiline prose but rejects bidi controls in %s',
    (field) => {
      expect(() => buildTaskCandidateCard({ ...CANDIDATE, [field]: 'line one\nline two' })).not.toThrow();
      expect(() => buildTaskCandidateCard({ ...CANDIDATE, [field]: 'safe\u202Espoofed' })).toThrow(new RegExp(field));
    },
  );

  it.each([
    ['CARRIAGE RETURN', '\r'],
    ['NEXT LINE', '\u0085'],
    ['LINE SEPARATOR', '\u2028'],
    ['PARAGRAPH SEPARATOR', '\u2029'],
    ['ZERO WIDTH SPACE', '\u200B'],
    ['WORD JOINER', '\u2060'],
    ['ZERO WIDTH NO-BREAK SPACE', '\uFEFF'],
  ])('rejects Unicode %s in multiline prose while retaining ordinary LF', (_name, character) => {
    expect(() => buildTaskCandidateCard({ ...CANDIDATE, summary: `line one${character}line two` }))
      .toThrow(/summary/);
    expect(() => buildTaskCandidateCard({ ...CANDIDATE, summary: 'line one\nline two' })).not.toThrow();
  });

  it('retains valid CJK, emoji ZWJ sequences and variation selectors', () => {
    expect(() => buildTaskCandidateCard({
      ...CANDIDATE,
      title: '修复预览页 ✅',
      summary: '支持家庭组合 emoji 👨‍👩‍👧‍👦 与文本变体 ✈️。',
    })).not.toThrow();
  });
});
