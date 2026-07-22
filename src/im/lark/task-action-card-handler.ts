import {
  MR_IGNORE_ACTION,
  MR_KEEP_WATCHING_ACTION,
  REPOSITORY_IGNORE_ACTION,
  TASK_ALLOW_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
  TASK_REJECT_ACTION,
} from './task-action-card.js';

export type TaskAction =
  | typeof TASK_ALLOW_ACTION
  | typeof TASK_REJECT_ACTION
  | typeof TASK_DISCUSS_ACTION
  | typeof TASK_FEEDBACK_ACTION
  | typeof MR_KEEP_WATCHING_ACTION
  | typeof MR_IGNORE_ACTION
  | typeof REPOSITORY_IGNORE_ACTION;

export type TaskActionSubject =
  | { type: 'candidate'; id: string }
  | { type: 'mr'; id: string }
  | { type: 'repository'; id: string };

export interface TaskActionPersistenceRequest {
  action: Exclude<TaskAction, typeof MR_KEEP_WATCHING_ACTION>;
  subject: TaskActionSubject;
  operatorOpenId: string;
}

type PersistedTaskAction = Exclude<TaskAction, typeof MR_KEEP_WATCHING_ACTION>;

export type TaskActionPersistenceResult = {
  outcome: 'recorded' | 'duplicate' | 'conflict';
  effectiveAction: PersistedTaskAction;
} & (
  | { triggerRequired: true; idempotencyKey: string; dispatchToken: string }
  | { triggerRequired: false }
);

export interface TaskActionTriggerRequest {
  action: typeof TASK_ALLOW_ACTION | typeof TASK_DISCUSS_ACTION | typeof TASK_FEEDBACK_ACTION;
  candidateId: string;
  mode: 'work' | 'discussion' | 'feedback';
  operatorOpenId: string;
  /** Stable opaque key allocated by the durable sink/outbox. */
  idempotencyKey: string;
  /** Per-claim fencing token; unlike idempotencyKey this changes on reclaim. */
  dispatchToken: string;
}

export interface TaskActionHandlerDeps {
  isAuthorized: (operatorOpenId: string) => boolean | Promise<boolean>;
  persist: (request: TaskActionPersistenceRequest) => Promise<TaskActionPersistenceResult>;
  /**
   * At-least-once boundary: the durable sink atomically decides whether this
   * callback owns a delivery attempt. A claimed attempt may be retried after a
   * crash or failure, always with the same idempotencyKey and a fresh
   * dispatchToken. Downstream execution must deduplicate the stable key, fence
   * stale claims with the token, and durably mark the current claim dispatched.
   */
  trigger: (request: TaskActionTriggerRequest) => void | Promise<void>;
}

export interface TaskActionHandlerResult {
  toast: { type: 'success' | 'info' | 'warning' | 'error'; content: string };
}

type PlainRecord = Record<string, unknown>;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KNOWN_ACTIONS = new Set<string>([
  TASK_ALLOW_ACTION,
  TASK_REJECT_ACTION,
  TASK_DISCUSS_ACTION,
  TASK_FEEDBACK_ACTION,
  MR_KEEP_WATCHING_ACTION,
  MR_IGNORE_ACTION,
  REPOSITORY_IGNORE_ACTION,
]);

const ACTION_LABELS: Readonly<Record<TaskAction, string>> = {
  [TASK_ALLOW_ACTION]: '允许',
  [TASK_REJECT_ACTION]: '拒绝',
  [TASK_DISCUSS_ACTION]: '细聊',
  [TASK_FEEDBACK_ACTION]: '阅读反馈',
  [MR_KEEP_WATCHING_ACTION]: '继续关注',
  [MR_IGNORE_ACTION]: '不再关注此 MR',
  [REPOSITORY_IGNORE_ACTION]: '不再关注此仓库',
};

/**
 * Handle a task-delivery card callback without trusting any card-carried
 * identity. The durable sink owns first-decision-wins and idempotency; this
 * module never keeps process-local decision state.
 */
export async function handleTaskActionCard(
  input: unknown,
  deps: TaskActionHandlerDeps,
): Promise<TaskActionHandlerResult> {
  const parsed = parseCallback(input);
  if (!parsed) return invalidResult();

  let authorized = false;
  try {
    authorized = await deps.isAuthorized(parsed.operatorOpenId);
  } catch {
    return unauthorizedResult();
  }
  if (authorized !== true) return unauthorizedResult();

  if (parsed.action === MR_KEEP_WATCHING_ACTION) {
    return toast('info', '将继续关注此 MR');
  }

  let persisted: TaskActionPersistenceResult;
  try {
    persisted = await deps.persist({
      action: parsed.action,
      subject: parsed.subject,
      operatorOpenId: parsed.operatorOpenId,
    });
  } catch {
    return persistenceFailedResult();
  }

  const safePersisted = parsePersistenceResult(persisted, parsed);
  if (!safePersisted) return persistenceFailedResult();
  persisted = safePersisted;

  if (persisted.triggerRequired) {
    const triggerRequest = toTriggerRequest(
      parsed.subject,
      persisted.effectiveAction,
      parsed.operatorOpenId,
      persisted.idempotencyKey,
      persisted.dispatchToken,
    );
    if (!triggerRequest) return persistenceFailedResult();
    try {
      await deps.trigger(triggerRequest);
    } catch {
      return toast('warning', '操作已保存，自动启动暂时失败');
    }
  }

  if (persisted.outcome !== 'recorded') {
    if (persisted.outcome === 'duplicate' && persisted.effectiveAction === parsed.action) {
      return toast('info', '该操作已处理，无需重复提交');
    }
    return toast(
      'warning',
      `任务已按「${ACTION_LABELS[persisted.effectiveAction]}」处理，本次操作未生效`,
    );
  }

  return successFor(parsed.action);
}

type ParsedCallback = {
  action: TaskAction;
  subject: TaskActionSubject;
  operatorOpenId: string;
};

function parseCallback(input: unknown): ParsedCallback | undefined {
  let data: unknown;
  try {
    data = copyPlainData(input, new WeakSet<object>(), 0);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;

  const operator = data.operator;
  const actionContainer = data.action;
  if (!isRecord(operator) || !isRecord(actionContainer) || !isRecord(actionContainer.value)) {
    return undefined;
  }
  const operatorOpenId = operator.open_id;
  const action = actionContainer.value.action;
  if (!isOpaqueId(operatorOpenId) || typeof action !== 'string' || !KNOWN_ACTIONS.has(action)) {
    return undefined;
  }

  const typedAction = action as TaskAction;
  const subject = subjectFor(typedAction, actionContainer.value);
  if (!subject) return undefined;
  return { action: typedAction, subject, operatorOpenId };
}

function subjectFor(action: TaskAction, value: PlainRecord): TaskActionSubject | undefined {
  if (
    action === TASK_ALLOW_ACTION
    || action === TASK_REJECT_ACTION
    || action === TASK_DISCUSS_ACTION
    || action === TASK_FEEDBACK_ACTION
  ) {
    return isOpaqueId(value.candidateId) ? { type: 'candidate', id: value.candidateId } : undefined;
  }
  if (action === MR_KEEP_WATCHING_ACTION || action === MR_IGNORE_ACTION) {
    return isOpaqueId(value.mrId) ? { type: 'mr', id: value.mrId } : undefined;
  }
  return isOpaqueId(value.repositoryId)
    ? { type: 'repository', id: value.repositoryId }
    : undefined;
}

function toTriggerRequest(
  subject: TaskActionSubject,
  action: PersistedTaskAction,
  operatorOpenId: string,
  idempotencyKey: string,
  dispatchToken: string,
): TaskActionTriggerRequest | undefined {
  if (subject.type !== 'candidate') return undefined;
  if (action === TASK_ALLOW_ACTION) {
    return {
      action,
      candidateId: subject.id,
      mode: 'work',
      operatorOpenId,
      idempotencyKey,
      dispatchToken,
    };
  }
  if (action === TASK_DISCUSS_ACTION) {
    return {
      action,
      candidateId: subject.id,
      mode: 'discussion',
      operatorOpenId,
      idempotencyKey,
      dispatchToken,
    };
  }
  if (action === TASK_FEEDBACK_ACTION) {
    return {
      action,
      candidateId: subject.id,
      mode: 'feedback',
      operatorOpenId,
      idempotencyKey,
      dispatchToken,
    };
  }
  return undefined;
}

function successFor(action: TaskAction): TaskActionHandlerResult {
  switch (action) {
    case TASK_ALLOW_ACTION:
      return toast('success', '已允许该任务，正在启动工作');
    case TASK_REJECT_ACTION:
      return toast('success', '已拒绝该任务');
    case TASK_DISCUSS_ACTION:
      return toast('success', '正在开启需求讨论');
    case TASK_FEEDBACK_ACTION:
      return toast('success', '正在继续反馈对话');
    case MR_IGNORE_ACTION:
      return toast('success', '已不再关注此 MR');
    case REPOSITORY_IGNORE_ACTION:
      return toast('success', '已不再关注此仓库');
    case MR_KEEP_WATCHING_ACTION:
      return toast('info', '将继续关注此 MR');
  }
}

function parsePersistenceResult(
  value: unknown,
  callback: ParsedCallback,
): TaskActionPersistenceResult | undefined {
  let data: unknown;
  try {
    data = copyPlainData(value, new WeakSet<object>(), 0);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  if (data.outcome !== 'recorded' && data.outcome !== 'duplicate' && data.outcome !== 'conflict') {
    return undefined;
  }
  if (typeof data.effectiveAction !== 'string'
    || data.effectiveAction === MR_KEEP_WATCHING_ACTION
    || !KNOWN_ACTIONS.has(data.effectiveAction)) return undefined;
  const effectiveAction = data.effectiveAction as PersistedTaskAction;
  if (!isEffectiveActionAllowed(callback, effectiveAction)) return undefined;
  if (data.outcome === 'recorded' && effectiveAction !== callback.action) return undefined;
  if (data.outcome === 'duplicate' && effectiveAction !== callback.action) return undefined;
  if (data.outcome === 'conflict' && effectiveAction === callback.action) return undefined;
  if (typeof data.triggerRequired !== 'boolean') return undefined;

  if (data.triggerRequired) {
    if (!isOpaqueId(data.idempotencyKey)
      || !isOpaqueId(data.dispatchToken)
      || !isTriggerableAction(effectiveAction)) return undefined;
    return {
      outcome: data.outcome,
      effectiveAction,
      triggerRequired: true,
      idempotencyKey: data.idempotencyKey,
      dispatchToken: data.dispatchToken,
    };
  }
  if (Object.hasOwn(data, 'idempotencyKey') || Object.hasOwn(data, 'dispatchToken')) return undefined;
  return {
    outcome: data.outcome,
    effectiveAction,
    triggerRequired: false,
  };
}

function isEffectiveActionAllowed(
  callback: ParsedCallback,
  effectiveAction: PersistedTaskAction,
): boolean {
  if (callback.subject.type === 'mr') return effectiveAction === MR_IGNORE_ACTION;
  if (callback.subject.type === 'repository') return effectiveAction === REPOSITORY_IGNORE_ACTION;
  if (callback.action === TASK_FEEDBACK_ACTION) return effectiveAction === TASK_FEEDBACK_ACTION;
  return effectiveAction === TASK_ALLOW_ACTION
    || effectiveAction === TASK_REJECT_ACTION
    || effectiveAction === TASK_DISCUSS_ACTION;
}

function isTriggerableAction(action: PersistedTaskAction): action is TaskActionTriggerRequest['action'] {
  return action === TASK_ALLOW_ACTION
    || action === TASK_DISCUSS_ACTION
    || action === TASK_FEEDBACK_ACTION;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toast(
  type: TaskActionHandlerResult['toast']['type'],
  content: string,
): TaskActionHandlerResult {
  return { toast: { type, content } };
}

function invalidResult(): TaskActionHandlerResult {
  return toast('warning', '操作无效或已失效');
}

function unauthorizedResult(): TaskActionHandlerResult {
  return toast('warning', '你没有权限执行此操作');
}

function persistenceFailedResult(): TaskActionHandlerResult {
  return toast('error', '操作保存失败，请稍后重试');
}

/**
 * Snapshot only ordinary data properties. Accessors, exotic prototypes,
 * symbols, cycles, excessive nesting and throwing Proxy traps are rejected.
 */
function copyPlainData(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.length > 4_096) throw new Error('string too long');
    return value;
  }
  if (typeof value !== 'object' || depth > 8) throw new Error('not data');

  const object = value as object;
  if (ancestors.has(object)) throw new Error('cyclic data');
  ancestors.add(object);
  try {
    const prototype = Object.getPrototypeOf(object);
    if (Array.isArray(object)) throw new Error('arrays are not part of task callbacks');
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid object');

    const keys = Reflect.ownKeys(object);
    if (keys.length > 128 || keys.some((key) => typeof key !== 'string')) throw new Error('invalid keys');
    const copy: PlainRecord = Object.create(null) as PlainRecord;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('accessor property');
      copy[key] = copyPlainData(descriptor.value, ancestors, depth + 1);
    }
    return copy;
  } finally {
    ancestors.delete(object);
  }
}
