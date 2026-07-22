# Task Approval Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure, durable task-delivery and MR-ignore interactive cards that can trigger repository-scoped botmux work immediately.

**Architecture:** New task-domain card builders produce opaque IDs only. A focused handler authenticates the platform operator through botmux owner policy, records an action through an injected durable sink, and invokes an injected trigger after persistence; `card-handler.ts` only dispatches the namespace.

**Tech Stack:** TypeScript, Lark card v2, Vitest, botmux daemon/session trigger APIs.

---

## File map

- `src/im/lark/task-action-card.ts`: candidate/completion/MR card schemas and action constants.
- `src/im/lark/task-action-card-handler.ts`: owner-gated, idempotent callback behavior.
- `src/services/task-action-sink.ts`: JSON-process adapter to Task OS CLI.
- `src/im/lark/card-handler.ts`: task namespace dispatch wiring only.
- `src/daemon.ts`: production dependencies for persistence and repository-scoped trigger.
- `src/cli/task-card.ts`: send candidate/completion/MR cards from scheduled skills.
- `test/task-action-card*.test.ts`: card values, auth, persistence-before-trigger, idempotency and failure behavior.

### Task 1: Card contracts

- [ ] Write failing tests requiring the three candidate actions, completion feedback, two ignore actions, opaque identifiers, and absence of user identity/secrets in values.
- [ ] Run `pnpm vitest run test/task-action-card.test.ts` and observe module-not-found.
- [ ] Implement card builders in `src/im/lark/task-action-card.ts`.
- [ ] Re-run the targeted test and commit with `Co-Authored-By: Riff`.

### Task 2: Secure action handler

- [ ] Write failing tests for verified `operator.open_id`, owner-only authorization, persistence before trigger, duplicate idempotency, and fail-closed malformed callbacks.
- [ ] Run `pnpm vitest run test/task-action-card-handler.test.ts` and observe module-not-found.
- [ ] Implement the dependency-injected handler and localized toast/card result.
- [ ] Re-run and commit with the required trailer.

### Task 3: Durable Task OS adapter

- [ ] Write failing tests with a fake executable proving argv-only invocation, JSON validation, timeouts, no shell expansion and stable result mapping.
- [ ] Run the targeted test and observe module-not-found.
- [ ] Implement `src/services/task-action-sink.ts` using `spawn` with explicit argv and configured state directory.
- [ ] Re-run and commit with the required trailer.

### Task 4: Dispatch and immediate execution

- [ ] Write failing integration tests proving `task_allow` records then starts the mapped workdir, `task_reject` never starts, `task_discuss` starts a discussion topic, ignore actions only update rules, and feedback resumes the original task.
- [ ] Run targeted tests and observe missing dispatch.
- [ ] Add `taskActionDeps` to `CardHandlerDeps`, namespace dispatch in `card-handler.ts`, and daemon wiring to the existing session trigger API.
- [ ] Re-run targeted tests and commit with the required trailer.

### Task 5: Card send CLI

- [ ] Write failing CLI tests for candidate, completion and MR JSON input, required chat/app IDs, validation and dry-run output.
- [ ] Run targeted tests and observe unknown command.
- [ ] Implement `src/cli/task-card.ts` and register `botmux task-card send`.
- [ ] Re-run targeted tests, `pnpm build`, and the full unit suite; compare against the recorded one-failure Dashboard CSS baseline.
- [ ] Commit with the required trailer.

### Task 6: Remote deploy

- [ ] Push the branch and install/update botmux on 214 from Git.
- [ ] Restart daemon and verify health.
- [ ] Send a real test candidate card and exercise allow/reject/discuss with the authorized owner.
- [ ] Restart daemon and verify decisions/ignore rules remain effective through Task OS state.
- [ ] Exercise completion feedback and capture the resulting topic/session IDs.
