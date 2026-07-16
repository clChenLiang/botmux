# Forward Follow-up Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将飞书话题群中相隔极短、以 `root_id` 关联的“转发内容 + 补充说明”合并成一个以后续消息为锚点的 botmux 会话。

**Architecture:** 在 Lark dispatcher 的最终会话分发前加入一个只保存已授权新话题种子的短时缓冲器；后续消息用 `root_id` 原子匹配并取消首条超时分发。配对后由 daemon 同时解析两条事件、合并正文与资源，但继续使用后续事件的发送者、标题和回复锚点。

**Tech Stack:** TypeScript, Vitest fake timers, Lark WS event dispatcher, existing message parser/merge-forward expansion.

---

### Task 1: 可配置等待时间

**Files:**
- Modify: `src/config.ts`
- Create: `test/forward-followup-config.test.ts`

- [ ] **Step 1: Write the failing configuration tests**

```ts
import { describe, expect, it } from 'vitest';
import { resolveForwardFollowupWaitMs } from '../src/config.js';

describe('resolveForwardFollowupWaitMs', () => {
  it('defaults to 1500ms', () => expect(resolveForwardFollowupWaitMs({})).toBe(1500));
  it('allows zero to disable', () => expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: '0' })).toBe(0));
  it('accepts and clamps positive values', () => {
    expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: '800' })).toBe(800);
    expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: '12000' })).toBe(10000);
  });
  it('falls back for invalid values', () => {
    expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: '-1' })).toBe(1500);
    expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: 'abc' })).toBe(1500);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run --project unit test/forward-followup-config.test.ts`

Expected: FAIL because `resolveForwardFollowupWaitMs` is not exported.

- [ ] **Step 3: Implement the resolver and config field**

```ts
export function resolveForwardFollowupWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BOTMUX_FORWARD_FOLLOWUP_WAIT_MS;
  if (raw == null || raw === '') return 1_500;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 1_500;
  if (value === 0) return 0;
  return Math.min(10_000, Math.max(1, Math.trunc(value)));
}
```

Add `forwardFollowupWaitMs: resolveForwardFollowupWaitMs()` under `config.daemon`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run --project unit test/forward-followup-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/forward-followup-config.test.ts
git commit -m "feat(config): 支持转发补充说明等待时间"
```

### Task 2: 原子短时缓冲器

**Files:**
- Create: `src/im/lark/forward-followup-buffer.ts`
- Create: `test/forward-followup-buffer.test.ts`

- [ ] **Step 1: Write failing fake-timer tests**

Cover: timeout flush; matching same app/chat/sender/root; mismatch retention; match-vs-timeout exactly-once; multiple pending message IDs.

The public contract is:

```ts
export interface ForwardSeed<T> {
  larkAppId: string;
  chatId: string;
  senderOpenId: string;
  messageId: string;
  payload: T;
  flush: (payload: T) => Promise<void>;
}

export class ForwardFollowupBuffer<T> {
  constructor(waitMs: number);
  hold(seed: ForwardSeed<T>): boolean;
  match(input: { larkAppId: string; chatId: string; senderOpenId: string; rootId: string }): T | undefined;
  clear(): void;
}
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run --project unit test/forward-followup-buffer.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal map + timer state machine**

Use a `Map<messageId, Pending<T>>`; delete the entry before either `flush` or `match`, and clear its timer on match. `hold` returns false when wait is disabled.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run --project unit test/forward-followup-buffer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/forward-followup-buffer.ts test/forward-followup-buffer.test.ts
git commit -m "feat(im/lark): 增加转发补充说明短时缓冲器"
```

### Task 3: Dispatcher 配对与后续消息锚定

**Files:**
- Modify: `src/im/lark/event-dispatcher.ts`
- Modify: `test/event-dispatcher.test.ts`

- [ ] **Step 1: Add failing dispatcher tests**

Add cases using `vi.useFakeTimers()`:

1. A human new-topic seed in a topic group does not call `handleNewTopic` before 1500ms, then calls it once.
2. A second event whose `root_id` points at the held seed cancels the first dispatch and calls `handleNewTopic` once with `anchor === followup.message_id` and `forwardSeedData === firstEvent`.
3. Same root but different sender/chat does not match.
4. p2p, regular-group, real thread reply and `/repo` command remain immediate.
5. wait=0 remains immediate.

- [ ] **Step 2: Run the relevant test and verify RED**

Run: `pnpm vitest run --project unit test/event-dispatcher.test.ts`

Expected: new coalescing cases FAIL.

- [ ] **Step 3: Extend RoutingContext and integrate the buffer**

Add:

```ts
/** Accepted first event paired to this follow-up turn. */
forwardSeedData?: any;
```

Create one buffer per `startLarkEventDispatcher` call. At the end of the human event path:

- probe `message.root_id` against accepted pending seeds using app/chat/sender;
- on match force `{ scope: 'thread', anchor: messageId }`, set `forwardSeedData`, and dispatch once;
- otherwise hold only accepted human topic-chat new-session seeds whose anchor equals messageId and which are not control commands;
- timeout dispatches the captured original `data` and context through `serializeByAnchor`;
- all other paths use the existing immediate serializer call.

- [ ] **Step 4: Run dispatcher tests and verify GREEN**

Run: `pnpm vitest run --project unit test/event-dispatcher.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/event-dispatcher.ts test/event-dispatcher.test.ts
git commit -m "fix(im/lark): 合并转发后的补充说明路由"
```

### Task 4: Daemon 合并首条正文与附件

**Files:**
- Create: `src/im/lark/forward-followup-content.ts`
- Create: `test/forward-followup-content.test.ts`
- Modify: `src/daemon.ts`

- [ ] **Step 1: Write failing content-composition tests**

Define and test a pure helper:

```ts
export function composeForwardFollowupContent(seedContent: string, followupContent: string): string {
  return `${seedContent.trim()}\n\n${followupContent.trim()}`;
}

export function bindResourcesToMessage(resources: MessageResource[], messageId: string): MessageResource[] {
  return resources.map(resource => ({ ...resource, messageId: resource.messageId ?? messageId }));
}
```

Assert ordering, whitespace, and preservation of pre-bound nested-forward resource message IDs.

- [ ] **Step 2: Run the helper test and verify RED**

Run: `pnpm vitest run --project unit test/forward-followup-content.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the helpers and integrate handleNewTopic**

When `ctx.forwardSeedData` exists:

1. resolve/parse the seed event;
2. expand seed `merge_forward` using the seed message ID;
3. bind seed top-level resources to the seed message ID;
4. prepend seed content to the follow-up content;
5. append seed resources before follow-up resources;
6. suppress the duplicate quote hint for this paired turn;
7. retain `parsed.content` as the follow-up text so the session title uses the user's instruction.

- [ ] **Step 4: Run focused tests and build**

Run:

```bash
pnpm vitest run --project unit test/forward-followup-content.test.ts test/event-dispatcher.test.ts
pnpm build
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/forward-followup-content.ts test/forward-followup-content.test.ts src/daemon.ts
git commit -m "fix(daemon): 合并转发正文与补充说明上下文"
```

### Task 5: Regression verification and MR

**Files:**
- Modify if needed: `README.md`, `README.en.md`, or `docs-site/docs/*/env.md` to document `BOTMUX_FORWARD_FOLLOWUP_WAIT_MS`.

- [ ] **Step 1: Document the environment variable**

Add the default, range and `0` disable semantics to both Chinese and English env docs.

- [ ] **Step 2: Run fresh verification**

```bash
pnpm vitest run --project unit test/forward-followup-config.test.ts test/forward-followup-buffer.test.ts test/forward-followup-content.test.ts test/event-dispatcher.test.ts
pnpm test
pnpm build
git diff --check
```

Expected: all tests pass, build exits 0, no whitespace errors.

- [ ] **Step 3: Review impact scope**

Confirm from the diff that only Lark topic-group new-session seeds are delayed; regular groups, p2p, existing topics, bot senders, control commands, workflows, other IM platforms and CLI/backend implementations are unchanged.

- [ ] **Step 4: Commit docs if changed**

```bash
git add docs-site/docs/zh/env.md docs-site/docs/en/env.md
git commit -m "docs(config): 说明转发补充说明等待参数"
```

- [ ] **Step 5: Push and create MR in the fork**

```bash
git push -u origin codex/merge-forward-followup
gh pr create --repo clChenLiang/botmux --base master --head codex/merge-forward-followup --title "fix(im/lark): 合并转发后的补充说明" --body-file <prepared-pr-body>
```

MR body must describe the verified 334ms/357ms event evidence, behavior/configuration, shared-layer impact assessment, and exact commands/results.
