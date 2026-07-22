/**
 * Lark v2 cards used by the remote task-delivery workflow.
 *
 * Callback values intentionally contain only an action and opaque identifiers.
 * Human-readable task content and evidence URLs remain display-only; handlers
 * must resolve the authoritative record from Task OS by ID.
 */

export const TASK_ALLOW_ACTION = 'task_allow' as const;
export const TASK_REJECT_ACTION = 'task_reject' as const;
export const TASK_DISCUSS_ACTION = 'task_discuss' as const;
export const TASK_FEEDBACK_ACTION = 'task_feedback' as const;
export const MR_KEEP_WATCHING_ACTION = 'task_watch_mr' as const;
export const MR_IGNORE_ACTION = 'task_ignore_mr' as const;
export const REPOSITORY_IGNORE_ACTION = 'task_ignore_repository' as const;

export interface TaskCandidateCardInput {
  candidateId: string;
  title: string;
  summary: string;
  source: string;
  recommendationReason: string;
  repositoryLabel: string;
  risk: string;
  validationMethod: string;
}

export interface TaskCompletionCardInput {
  candidateId: string;
  title: string;
  environment: string;
  prdUrl: string;
  testReportUrl: string;
  mrUrl: string;
  diffScreenshotUrl: string;
  previewUrl: string;
  ppeUrl: string;
}

export interface MrAttentionCardInput {
  mrId: string;
  repositoryId: string;
  title: string;
  summary: string;
  repositoryLabel: string;
}

type CallbackValue = Readonly<Record<string, string>>;
type ButtonType = 'primary' | 'danger' | 'default';

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_EXCEPT_TAB_LF = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const INVISIBLE_FORMATTING = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/;

export function buildTaskCandidateCard(input: TaskCandidateCardInput): string {
  const candidateId = opaqueId(input.candidateId, 'candidateId');
  const fields = [
    labeledText('标题', singleLineText(input.title, 'title', 200)),
    labeledText('摘要', proseText(input.summary, 'summary', 4_000)),
    labeledText('来源', singleLineText(input.source, 'source', 300)),
    labeledText('推荐理由', proseText(input.recommendationReason, 'recommendationReason', 4_000)),
    labeledText('仓库', singleLineText(input.repositoryLabel, 'repositoryLabel', 200)),
    labeledText('风险', proseText(input.risk, 'risk', 4_000)),
    labeledText('预估验证方式', proseText(input.validationMethod, 'validationMethod', 4_000)),
  ];

  return buildCard('blue', '任务候选', fields, [
    callbackButton('允许', 'primary', { action: TASK_ALLOW_ACTION, candidateId }),
    callbackButton('拒绝', 'danger', { action: TASK_REJECT_ACTION, candidateId }),
    callbackButton('细聊', 'default', { action: TASK_DISCUSS_ACTION, candidateId }),
  ]);
}

export function buildTaskCompletionCard(input: TaskCompletionCardInput): string {
  const candidateId = opaqueId(input.candidateId, 'candidateId');
  const title = singleLineText(input.title, 'title', 200);
  const environment = singleLineText(input.environment, 'environment', 500);
  const links = [
    ['产品需求', safeHttpsUrl(input.prdUrl, 'prdUrl')],
    ['测试报告', safeHttpsUrl(input.testReportUrl, 'testReportUrl')],
    ['MR', safeHttpsUrl(input.mrUrl, 'mrUrl')],
    ['diff 截图', safeHttpsUrl(input.diffScreenshotUrl, 'diffScreenshotUrl')],
    ['Preview', safeHttpsUrl(input.previewUrl, 'previewUrl')],
    ['PPE', safeHttpsUrl(input.ppeUrl, 'ppeUrl')],
  ] as const;

  return buildCard('green', '任务已完成', [
    labeledText('标题', title),
    labeledText('运行环境', environment),
    '**交付材料**',
    ...links.map(([label, url]) => `[${label}](${url})`),
  ], [callbackButton('阅读反馈', 'primary', { action: TASK_FEEDBACK_ACTION, candidateId })]);
}

export function buildMrAttentionCard(input: MrAttentionCardInput): string {
  const mrId = opaqueId(input.mrId, 'mrId');
  const repositoryId = opaqueId(input.repositoryId, 'repositoryId');
  const fields = [
    labeledText('标题', singleLineText(input.title, 'title', 200)),
    labeledText('摘要', proseText(input.summary, 'summary', 4_000)),
    labeledText('仓库', singleLineText(input.repositoryLabel, 'repositoryLabel', 200)),
  ];

  return buildCard('orange', 'MR 巡检', fields, [
    callbackButton('继续关注', 'primary', { action: MR_KEEP_WATCHING_ACTION, mrId }),
    callbackButton('不再关注此 MR', 'default', { action: MR_IGNORE_ACTION, mrId }),
    callbackButton('不再关注此仓库', 'default', {
      action: REPOSITORY_IGNORE_ACTION,
      repositoryId,
    }),
  ]);
}

function buildCard(
  template: 'blue' | 'green' | 'orange',
  heading: string,
  markdownElements: string[],
  buttons: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template,
      title: { tag: 'plain_text', content: heading },
    },
    body: {
      direction: 'vertical',
      elements: [
        ...markdownElements.map((content) => ({ tag: 'markdown', content })),
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: buttons.map((button) => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [button],
          })),
        },
      ],
    },
  });
}

function callbackButton(label: string, type: ButtonType, value: CallbackValue): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value: { ...value } }],
  };
}

function labeledText(label: string, value: string): string {
  return `**${label}**\n${escapeLarkMarkdown(value)}`;
}

function opaqueId(value: string, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new Error(`${field} must be an opaque identifier (1-128 safe characters)`);
  }
  return value;
}

function singleLineText(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength
    || /[\t\r\n]/.test(value) || CONTROL_EXCEPT_TAB_LF.test(value) || INVISIBLE_FORMATTING.test(value)) {
    throw new Error(`${field} must be single-line visible text up to ${maxLength} characters`);
  }
  return value;
}

function proseText(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength
    || CONTROL_EXCEPT_TAB_LF.test(value) || BIDI_CONTROL.test(value)) {
    throw new Error(`${field} must be safe display text up to ${maxLength} characters`);
  }
  return value;
}

function safeHttpsUrl(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048
    || /\s/.test(value) || CONTROL_EXCEPT_TAB_LF.test(value) || INVISIBLE_FORMATTING.test(value)) {
    throw new Error(`${field} must be a safe HTTPS URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a safe HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0 || parsed.username || parsed.password) {
    throw new Error(`${field} must be a safe HTTPS URL`);
  }

  return parsed.toString().replace(/[()[\]\\]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function escapeLarkMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\*_~`\[\]]/g, (character) => `\\${character}`);
}
