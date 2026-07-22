# CFLS V2 — Build Memory & Context

> **Purpose of this file:** the single, always-current source of truth for the V2
> build. If context is ever lost, READ THIS FIRST. It records the vision, what is
> already built, what V2 adds, the phase plan, decisions, conventions, and a live
> progress tracker. Update the "Progress tracker" section after every task.

---

## 0. Source of truth

- **Vision:** `Documentation/idea.md` (also mirrored to the user's `Downloads/idea.md`).
  V2 exists to build the parts of that vision the MVP (V1) deliberately did not ship.
- **V1 spec (already delivered):** `.kiro/specs/collaborative-file-lock-sync/`
  (requirements.md / design.md / tasks.md). V2 does **not** rewrite V1; it extends it.
- **V2 spec (this build):** `.kiro/specs/v2-collaboration-layer/`.

## 1. Working rules (do not violate)

1. **Branch:** all V2 work is committed to the `V2` branch. Merge `V2` → `main`
   with a **regular merge (never squash)** at the end of each phase, so every
   commit stays on the contribution graph on its original date.
2. **Commit granularity:** commit after **every file created or every task
   finished**. Small, frequent commits. Use clear messages:
   `V2(phaseN/taskX): <what>`.
3. **Do NOT push** unless the user explicitly asks. Commit locally only.
4. **No build errors, ever.** Keep `pnpm typecheck` and `pnpm test` green before
   moving to the next task. Each task must leave the tree in a working state.
5. **Match existing conventions:** strict TypeScript, ESM, JSDoc tone of
   `apps/*/src` and `packages/*/src`; EARS requirements; numbered tasks; property
   tests via `@cfls/test-utils` (≥100 runs, tagged).
6. **Metadata-only principle stays.** Coordination shares metadata, never source
   bytes — EXCEPT the opt-in "live diffs" feature (Phase 5), which is explicitly
   gated and off by default.
7. **Reuse, don't reinvent.** Build on `@cfls/protocol`, `@cfls/core-state`,
   `@cfls/security`, `@cfls/host`, `@cfls/agent`, `@cfls/mcp-server`.

## 2. What is already built (V1 MVP — DONE)

- Host authority (WSS/TLS, ingest gate, monotonic Event_Revision, persistence,
  restart recovery, dashboard).
- Local Agent (watcher, encrypted cache, loopback Local_API, embedded MCP,
  offline/stale, reconnect sync + re-assert).
- Protocol package (versioned envelope, message catalog, DTOs, error codes,
  hand-written validator).
- core-state (locks, presence, intents, risk, conflict-by-earliest-revision,
  sync, expiry, coalescing, data-minimization).
- security (Ed25519 keys, signing, signed invitations, revocation/rotation,
  replay guard, credential store).
- dependency-analyzer (metadata-only TS/JS graph, manifests, contract hashes).
- mcp-server (13 tools), vscode-extension (status item + team panel + hard-stop),
  cli (`cfls` onboarding/host/agent/mcp/service/sync), Git-sync (opt-in).
- Tests: unit + property + integration + 5-agent simulation.

## 3. Gap analysis — what V2 adds (from idea.md §6)

| idea.md capability | V1 status | V2 phase |
| --- | --- | --- |
| Agent↔agent messaging (direct/broadcast, priority, questions, FYIs) | ❌ | **P1** |
| Shared task system + assignment + human approval of incoming work | 🟡 (only intents) | **P2** |
| Notifications (severity/sound) + liveness active/idle/gone + wake idle agent | 🟡 | **P3** |
| Luna orchestrator (assign/route, arbitrate, answer, summarize) | ❌ | **P4** |
| Live diffs (opt-in) | ❌ (intentionally excluded) | **P5** |

Already strong in V1 (do not rebuild): live "who's on what", IDE panel,
reconnect safety, identity/invites/revocation, secrets never shared.

## 4. Phase plan (dependency order)

- **Phase 1 — Messaging channel.** Directed + broadcast messages, priority
  (fyi/normal/urgent), question/answer with correlation ids, delivery + read
  state. Foundation for P2/P3/P4.
- **Phase 2 — Tasks & approvals.** Shared task objects, per-member task lists,
  assign a task to a member, receiving human approves/rejects before it lands.
  Builds on P1.
- **Phase 3 — Notifications, liveness & wake.** active/idle/gone status,
  severity-based notifications surfaced in the extension, "wake/resume" a member's
  agent (delivered at its next action — honor idle non-goal).
- **Phase 4 — Luna orchestrator.** Central orchestrator: intelligent task
  assignment, conflict arbitration beyond mechanical rules, answering cross-agent
  questions, plain-language team summaries. Rules-based core with an OPTIONAL
  pluggable LLM adapter (off by default; no API key required to build/run).
- **Phase 5 — Live diffs (opt-in).** Share change diffs within the trusted team,
  strictly opt-in and gated; largest data-model change, done last.

Each phase flows through the stack:
`protocol` → `core-state` → `host` → `agent` → `mcp-server` → `vscode-extension`,
with tests at each layer, then a phase-end merge `V2` → `main`.

## 5. Key decisions

- **Luna is rules-based by default**, with a typed `LunaBrain` interface and an
  optional LLM adapter that is disabled unless configured. This respects the
  idea.md principle "keep cheap mechanical decisions out of the expensive path"
  and keeps the build/test deterministic and key-free.
- **Messaging is metadata-ish but may carry human/agent text** (message bodies,
  questions, answers, task descriptions). This is team content shared within the
  trusted team per idea.md §6 Safety — still never secrets, credentials, or files
  outside the repo. Data-minimization still rejects secrets/absolute paths.
- **Live diffs are the only feature that moves source-derived content**, so it is
  opt-in, gated by config, and clearly separated (Phase 5).
- **New MCP tools** are added for messaging/tasks/Luna so AI agents are
  first-class participants (idea.md §2).

## 6. Naming (proposed, refined in the spec)

New protocol message categories: `message.*`, `task.*`, `notify.*`, `luna.*`,
`diff.*`. New core-state modules: `messaging.ts`, `tasks.ts`, `liveness.ts`,
`orchestrator.ts`, `diffs.ts`. New MCP tools grouped alongside the existing 13.

## 7. Progress tracker (UPDATE AFTER EVERY TASK)

- [x] Spec authored (requirements / design / tasks) — DONE
- [ ] Phase 1 — Messaging (protocol layer done: 1.1, 1.2)
- [ ] Phase 2 — Tasks & approvals
- [ ] Phase 3 — Notifications, liveness & wake
- [ ] Phase 4 — Luna orchestrator
- [ ] Phase 5 — Live diffs (opt-in)

### Task log
- (append: `YYYY-MM-DD  V2(phaseN/taskX)  <commit hash>  <summary>`)
- V2(spec)  69dabbc/fbc7828/7b13d35/6a331ec  memory + requirements + design + tasks
- V2(p1/1.1) 7f63288  protocol: message.* types, MessageDto, MessageKind/Priority
- V2(p1/1.2) 20de98d  protocol: message.* validation schemas + unit tests (71 tests green)
- V2(p1/1.3) beecf83  core-state: MessageRegistry (addressing, Q/A, read state)
- V2(p1/1.4) 36ca765  core-state: MessageRegistry unit + property tests (307 tests green)
- NOTE: whole workspace `pnpm -r build` green; run `pnpm -r build` before core-state
  tests so @cfls/security dist resolves (ingest suites depend on it).
