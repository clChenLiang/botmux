import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  buildMrAttentionCard,
  buildTaskCandidateCard,
  buildTaskCompletionCard,
  type MrAttentionCardInput,
  type TaskCandidateCardInput,
  type TaskCompletionCardInput,
} from '../im/lark/task-action-card.js';
import { createTaskCandidateRegistry } from './task-candidate-registry.js';
import {
  executeTaskCardDelivery,
  TaskCardDeliveryError,
  type TaskCardDeliveryStatus,
  type TaskCardKind,
} from './task-card-delivery-store.js';
import type { TaskCandidateRecord } from './task-action-dispatch.js';
import {
  pinPrivateStateDirectory,
  type PrivateStateDirectory,
  type PrivateStateHooks,
} from './private-task-state.js';

export type { TaskCardKind } from './task-card-delivery-store.js';

const OPAQUE_ID = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/;
const COMMON_KEYS = ['schemaVersion', 'deliveryId', 'larkAppId', 'chatId', 'card'] as const;
const CANDIDATE_CARD_KEYS = [
  'candidateId', 'title', 'summary', 'source', 'recommendationReason',
  'repositoryLabel', 'risk', 'validationMethod',
] as const;
const COMPLETION_CARD_KEYS = [
  'candidateId', 'title', 'environment', 'prdUrl', 'testReportUrl', 'mrUrl',
  'diffScreenshotUrl', 'previewUrl', 'ppeUrl',
] as const;
const MR_CARD_KEYS = ['mrId', 'repositoryId', 'title', 'summary', 'repositoryLabel'] as const;
const CANDIDATE_KEYS = ['candidateId', 'repositoryId', 'chatId', 'prompt', 'sourceRef'] as const;

export interface TaskCardDeliveryDeps {
  now?: () => string;
  registerBot?: (larkAppId: string) => void | Promise<void>;
  sendMessage?: (
    larkAppId: string, chatId: string, content: string, msgType: string, uuid: string,
  ) => Promise<string>;
  privateStateHooks?: PrivateStateHooks;
}

export async function deliverTaskCard(
  stateDir: string,
  kind: TaskCardKind,
  input: unknown,
  deps: TaskCardDeliveryDeps = {},
): Promise<{ status: TaskCardDeliveryStatus }> {
  let guard: PrivateStateDirectory;
  try { guard = await pinPrivateStateDirectory(stateDir); } catch {
    throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
  }
  try {
    let envelope: ValidEnvelope;
    try { envelope = parseEnvelope(kind, input); } catch (error) {
      if (error instanceof TaskCardDeliveryError) throw error;
      throw new TaskCardDeliveryError('ERR_TASK_CARD_INPUT');
    }

    const registry = createTaskCandidateRegistry(join(stateDir, 'task-candidates.json'), {
      privateStateHooks: deps.privateStateHooks,
    });
    if (envelope.candidate) {
      try { await registry.persist(envelope.candidate); } catch (error) {
        if (String((error as Error)?.message).includes('conflict')) {
          throw new TaskCardDeliveryError('ERR_TASK_CARD_CONFLICT');
        }
        throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
      }
      await revalidateStateDir(guard);
    }

    const register = deps.registerBot ?? defaultRegisterBot;
    try { await register(envelope.larkAppId); } catch {
      await revalidateStateDir(guard);
      throw new TaskCardDeliveryError('ERR_TASK_CARD_SEND');
    }
    await revalidateStateDir(guard);
    const send = deps.sendMessage ?? defaultSendMessage;
    const inputHash = createHash('sha256').update(JSON.stringify(envelope.canonical)).digest('hex');
    const status = await executeTaskCardDelivery(join(stateDir, 'task-card-deliveries.json'), {
      kind,
      deliveryId: envelope.deliveryId,
      inputHash,
      now: deps.now?.() ?? new Date().toISOString(),
      send: (uuid) => send(
        envelope.larkAppId, envelope.chatId, envelope.cardContent, 'interactive', uuid,
      ),
      afterSend: async (messageId) => {
        if (!envelope.candidate) return;
        try { await registry.bindRootMessage(envelope.candidate.candidateId, messageId); } catch (error) {
          if (String((error as Error)?.message).includes('conflict')) {
            throw new TaskCardDeliveryError('ERR_TASK_CARD_CONFLICT');
          }
          throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE');
        }
      },
    }, {
      guard,
      privateStateHooks: deps.privateStateHooks,
    });
    await revalidateStateDir(guard);
    return { status };
  } finally {
    await guard.close().catch(() => { throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE'); });
  }
}

/** Validate the exact, kind-specific envelope without performing any side effect. */
export function validateTaskCardEnvelope(kind: TaskCardKind, input: unknown): void {
  try { parseEnvelope(kind, input); } catch {
    throw new TaskCardDeliveryError('ERR_TASK_CARD_INPUT');
  }
}

interface ValidEnvelope {
  deliveryId: string;
  larkAppId: string;
  chatId: string;
  cardContent: string;
  candidate?: TaskCandidateRecord;
  canonical: Record<string, unknown>;
}

function parseEnvelope(kind: TaskCardKind, input: unknown): ValidEnvelope {
  if (!isRecord(input)) throw new Error('invalid');
  const expected = kind === 'candidate' ? [...COMMON_KEYS, 'candidate'] : [...COMMON_KEYS];
  if (!exactKeys(input, expected) || input.schemaVersion !== 1
    || !opaque(input.deliveryId) || !opaque(input.larkAppId) || !opaque(input.chatId)
    || !input.larkAppId.startsWith('cli_') || !input.chatId.startsWith('oc_') || !isRecord(input.card)) {
    throw new Error('invalid');
  }
  let cardContent: string;
  let card: Record<string, unknown>;
  let candidate: TaskCandidateRecord | undefined;
  if (kind === 'candidate') {
    card = exactCard(input.card, CANDIDATE_CARD_KEYS);
    const candidateValue = input.candidate;
    if (!isRecord(candidateValue) || !exactKeys(candidateValue, CANDIDATE_KEYS)
      || !allStrings(candidateValue, CANDIDATE_KEYS)
      || !opaque(candidateValue.candidateId) || !opaque(candidateValue.repositoryId)
      || !opaque(candidateValue.chatId)
      || !safeText(candidateValue.prompt) || !safeText(candidateValue.sourceRef)
      || candidateValue.candidateId !== card.candidateId
      || candidateValue.chatId !== input.chatId) throw new Error('invalid');
    candidate = Object.fromEntries(
      CANDIDATE_KEYS.map((key) => [key, candidateValue[key]]),
    ) as unknown as TaskCandidateRecord;
    cardContent = buildTaskCandidateCard(card as unknown as TaskCandidateCardInput);
  } else if (kind === 'completion') {
    card = exactCard(input.card, COMPLETION_CARD_KEYS);
    cardContent = buildTaskCompletionCard(card as unknown as TaskCompletionCardInput);
  } else if (kind === 'mr') {
    card = exactCard(input.card, MR_CARD_KEYS);
    cardContent = buildMrAttentionCard(card as unknown as MrAttentionCardInput);
  } else {
    throw new Error('invalid');
  }
  const canonical: Record<string, unknown> = {
    schemaVersion: 1,
    deliveryId: input.deliveryId,
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    card,
    ...(candidate ? { candidate } : {}),
  };
  return {
    deliveryId: input.deliveryId,
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    cardContent,
    ...(candidate ? { candidate } : {}),
    canonical,
  };
}

function exactCard(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  if (!exactKeys(value, keys) || !allStrings(value, keys)) throw new Error('invalid');
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

async function revalidateStateDir(guard: PrivateStateDirectory): Promise<void> {
  try { await guard.revalidate(); } catch { throw new TaskCardDeliveryError('ERR_TASK_CARD_STATE'); }
}

async function defaultRegisterBot(larkAppId: string): Promise<void> {
  const { loadBotConfigs, registerBot } = await import('../bot-registry.js');
  const config = loadBotConfigs().find((item) => item.larkAppId === larkAppId);
  if (!config) throw new Error('missing bot');
  registerBot(config);
}

async function defaultSendMessage(
  larkAppId: string, chatId: string, content: string, msgType: string, uuid: string,
): Promise<string> {
  const { sendMessage } = await import('../im/lark/client.js');
  return sendMessage(larkAppId, chatId, content, msgType, uuid);
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function allStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string');
}

function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
