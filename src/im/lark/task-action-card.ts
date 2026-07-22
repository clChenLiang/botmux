/**
 * Lark v2 cards used by the remote task-delivery workflow.
 *
 * Callback values intentionally contain only an action and opaque identifiers.
 * Human-readable (and potentially sensitive) task content remains display-only;
 * handlers must resolve the authoritative record from Task OS by ID.
 */

export const TASK_ALLOW_ACTION = 'task_allow' as const;
export const TASK_REJECT_ACTION = 'task_reject' as const;
export const TASK_DISCUSS_ACTION = 'task_discuss' as const;
export const TASK_FEEDBACK_ACTION = 'task_feedback' as const;
export const MR_IGNORE_ACTION = 'task_ignore_mr' as const;
export const REPOSITORY_IGNORE_ACTION = 'task_ignore_repository' as const;

export interface TaskCandidateCardInput {
  candidateId: string;
  title: string;
  summary: string;
  repositoryLabel?: string;
}

export interface TaskCompletionCardInput {
  candidateId: string;
  title: string;
  summary: string;
}

export interface MrAttentionCardInput {
  mrId: string;
  repositoryId: string;
  title: string;
  summary: string;
  repositoryLabel?: string;
}

type CallbackValue = Readonly<Record<string, string>>;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DISPLAY_LIMITS = {
  title: 200,
  summary: 4_000,
  repositoryLabel: 200,
} as const;

export function buildTaskCandidateCard(input: TaskCandidateCardInput): string {
  const candidateId = opaqueId(input.candidateId, 'candidateId');
  return taskCard({
    template: 'blue',
    heading: '任务候选',
    title: displayText(input.title, 'title', DISPLAY_LIMITS.title),
    summary: displayText(input.summary, 'summary', DISPLAY_LIMITS.summary),
    repositoryLabel: optionalDisplayText(input.repositoryLabel, 'repositoryLabel'),
    buttons: [
      callbackButton('允许', 'primary', { action: TASK_ALLOW_ACTION, candidateId }),
      callbackButton('拒绝', 'danger', { action: TASK_REJECT_ACTION, candidateId }),
      callbackButton('细聊', 'default', { action: TASK_DISCUSS_ACTION, candidateId }),
    ],
  });
}

export function buildTaskCompletionCard(input: TaskCompletionCardInput): string {
  const candidateId = opaqueId(input.candidateId, 'candidateId');
  return taskCard({
    template: 'green',
    heading: '任务已完成',
    title: displayText(input.title, 'title', DISPLAY_LIMITS.title),
    summary: displayText(input.summary, 'summary', DISPLAY_LIMITS.summary),
    buttons: [callbackButton('阅读反馈', 'primary', { action: TASK_FEEDBACK_ACTION, candidateId })],
  });
}

export function buildMrAttentionCard(input: MrAttentionCardInput): string {
  const mrId = opaqueId(input.mrId, 'mrId');
  const repositoryId = opaqueId(input.repositoryId, 'repositoryId');
  return taskCard({
    template: 'orange',
    heading: 'MR 巡检',
    title: displayText(input.title, 'title', DISPLAY_LIMITS.title),
    summary: displayText(input.summary, 'summary', DISPLAY_LIMITS.summary),
    repositoryLabel: optionalDisplayText(input.repositoryLabel, 'repositoryLabel'),
    buttons: [
      callbackButton('不再关注此 MR', 'default', { action: MR_IGNORE_ACTION, mrId }),
      callbackButton('不再关注此仓库', 'default', {
        action: REPOSITORY_IGNORE_ACTION,
        repositoryId,
      }),
    ],
  });
}

function taskCard(input: {
  template: 'blue' | 'green' | 'orange';
  heading: string;
  title: string;
  summary: string;
  repositoryLabel?: string;
  buttons: Array<Record<string, unknown>>;
}): string {
  const details = [
    `**${escapeLarkMarkdown(input.title)}**`,
    input.repositoryLabel ? `仓库：${escapeLarkMarkdown(input.repositoryLabel)}` : undefined,
    escapeLarkMarkdown(input.summary),
  ].filter((line): line is string => line !== undefined).join('\n\n');

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: input.template,
      title: { tag: 'plain_text', content: input.heading },
    },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: details },
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: input.buttons.map((button) => ({
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

function callbackButton(
  label: string,
  type: 'primary' | 'danger' | 'default',
  value: CallbackValue,
): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: displayText(label, 'button label', 40) },
    type,
    behaviors: [{ type: 'callback', value: { ...value } }],
  };
}

function opaqueId(value: string, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new Error(`${field} must be an opaque identifier (1-128 safe characters)`);
  }
  return value;
}

function optionalDisplayText(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : displayText(value, field, DISPLAY_LIMITS.repositoryLabel);
}

function displayText(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be non-empty safe display text up to ${maxLength} characters`);
  }
  return value;
}

function escapeLarkMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\*_~`\[\]]/g, (character) => `\\${character}`);
}
