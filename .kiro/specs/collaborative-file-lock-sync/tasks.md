# Implementation Plan: Collaborative File Lock Sync (Host-Based MVP)

## Overview

This plan turns the design into an incremental, test-driven build for the TypeScript/Node.js
monorepo. Work proceeds bottom-up: scaffolding → shared `protocol` → `security` → pure
`core-state` engine → `dependency-analyzer` → `mcp-server` → `apps/host` → `apps/agent` →
`apps/vscode-extension` → 5-agent `simulation`. Each task builds on prior ones and ends by
wiring into the running system, so there is no orphaned code.

Scope is MVP (Requirements 1–35). Requirement 36 (Future) is deferred; tasks only leave clean
extension points (the `Store` DAO, `LanguageAnalyzer` interface, transport-agnostic envelope)
and never implement Future behavior.

The 15 correctness properties from the design's "Correctness Properties" section are each
implemented as a single `fast-check` property test (≥100 iterations), tagged
`Feature: collaborative-file-lock-sync, Property N: <text>`, and placed beside the package that
owns the logic. Test sub-tasks (unit, integration, property) are marked `*` (optional / skippable
for a faster MVP); core implementation sub-tasks are never optional.

> Convention: every task lists a short **Goal**, the specific requirement clauses it implements,
> and (where applicable) the design section or Property number it realizes.

## Tasks

- [x] 1. Monorepo scaffolding, build tooling, and documentation
  - **Goal:** Stand up the pnpm-workspace monorepo, shared TypeScript/build/lint config, the
    fast-check-enabled test runner, and the seeded `docs/` set so every later package has a home.
  - [x] 1.1 Initialize workspace, TypeScript, and build/lint tooling
    - Create root `package.json` (workspaces), `pnpm-workspace.yaml`, and `tsconfig.base.json`
      with TypeScript project references; create empty `apps/{host,agent,vscode-extension}` and
      `packages/{protocol,core-state,dependency-analyzer,mcp-server,security}` package skeletons.
    - Configure `tsup`/`esbuild` build scripts, ESLint + Prettier, and a root `build`/`lint` script.
    - _Requirements: 1.8 (store relocation structure), 2.2 (no-admin build); Design "Project Structure"_
  - [x] 1.2 Configure the test runner and property-testing harness
    - Add the test runner (vitest) and `fast-check`; establish the PBT tagging convention
      `Feature: collaborative-file-lock-sync, Property N: <text>` and a shared helper enforcing
      `numRuns >= 100`; add `unit`, `integration`, `simulation` test folders under `tests/`.
    - _Requirements: none (infra); Design "Testing Strategy" §13.1–13.2_
  - [x] 1.3 Seed the `docs/` files from the design
    - Create `docs/architecture.md`, `docs/protocol.md`, `docs/threat-model.md`,
      `docs/deployment.md`, and `docs/testing.md`, seeded with the corresponding design sections
      (trust zones, message protocol, STRIDE table, laptop→VPS deployment, testing strategy).
    - _Requirements: none (docs); Design "Architecture", "Network & Message Protocol", "Security & Threat Model"_

- [ ] 2. `packages/protocol` — versioned envelope, catalog, DTOs, schemas
  - **Goal:** Establish the single source of truth for wire compatibility used by host, agent,
    mcp-server, and extension.
  - [x] 2.1 Define core DTOs and shared types
    - Implement `SessionId`, `MemberRef`, `RepositorySession`, `EventEnvelope`, `SignedEvent`,
      `Lock`, `Presence`, `DeclaredIntent`, `PlannedFileCreation`, `RiskMapEntry`,
      `CoordinationUpdate`, `AuditRecord`, `MembershipRegistryEntry`, and the Dependency_Graph
      metadata types (`RepositorySnapshotMetadata`, `PackageDependencyMetadata`,
      `DependencyEdge`, `ModuleDependencyMetadata`, `PublicContractFingerprint`,
      `ChangeDeltaMetadata`, `DependencyGraph`), plus `RiskLevel`/`ScopeKind`/`EdgeKind`/`Confidence`.
    - _Requirements: 7.1, 10.1, 24.7; Design §5.1_
  - [x] 2.2 Implement the versioned envelope, message catalog, and error codes
    - Define `MESSAGE_FORMAT_VERSION`, the canonical envelope shape (`type`, `version`, `eventId`,
      `session`, `deviceId`, `replay{counter,nonce}`, `sentAt`, `payload`, `signature`), the full
      message catalog (auth/presence/locks/intents/dependency/path/heartbeat/sync/broadcast/error),
      and the `ErrorCode` union.
    - _Requirements: 7.1, 7.6; Design §4.2, §4.3, §11.1_
  - [ ] 2.3 Implement JSON schemas and validation
    - Add JSON-schema definitions and a `validateEnvelope`/`validatePayload` function that rejects
      malformed or unsupported-version messages with `FORMAT_ERROR`; provide canonicalization used
      for signing.
    - _Requirements: 7.6, 7.7; Design §4.4, §4.7_
  - [ ]* 2.4 Write unit tests for schema and version validation
    - Cover accepted/rejected payloads per message type, unsupported version → `FORMAT_ERROR`,
      and canonicalization stability.
    - _Requirements: 7.6, 7.7_
  - [ ]* 2.5 Write unit tests for the error-code catalog and envelope construction
    - Assert each `ErrorCode` maps to the requirement it represents and envelopes round-trip through construct/parse.
    - _Requirements: 7.1, 11.1_

- [ ] 3. `packages/security` — identity, invitations, replay, credential store
  - **Goal:** Provide Ed25519 identity and the authenticity/replay gates that the host and agent rely on.
  - [ ] 3.1 Implement Ed25519 key generation, signing, and verification
    - Generate Device_Key pairs, sign the canonical envelope, and verify signatures against a
      Device_Public_Key.
    - _Requirements: 5.1, 7.1, 7.2; Design §8.2, §8.3_
  - [ ] 3.2 Implement signed invitations, revocation, and key rotation checks
    - Issue a `Signed_Invitation` from an admin device; validate that an invitation signature
      chains to an authorized admin before admission; implement revocation and rotation predicates
      against a `Membership_Registry` view.
    - _Requirements: 5.2, 5.5, 5.6, 5.7; Design §8.2, §8.5_
  - [ ] 3.3 Implement replay-protection counter and nonce logic
    - Track the highest accepted per-device monotonic counter and used nonces; expose an
      `acceptReplay(deviceId, counter, nonce)` predicate that rejects `counter <= last` or a reused nonce.
    - _Requirements: 7.5; Design §4.4_
  - [ ] 3.4 Implement the OS credential store adapter with encrypted-file fallback
    - Wrap Windows Credential Manager (`keytar`) with an encrypted-file fallback for storing the
      Device_Private_Key; surface a `SECURE_STORAGE_UNAVAILABLE` error when neither is usable.
    - _Requirements: 5.8, 5.9; Design §8.2_
  - [ ]* 3.5 Write property test — replay rejection leaves state unchanged
    - **Property 4: Replay rejection leaves state unchanged**
    - **Validates: Requirements 7.5**
  - [ ]* 3.6 Write property test — only authentically signed, admitted events mutate state
    - **Property 5: Only authentically signed, admitted events mutate state**
    - **Validates: Requirements 7.2, 7.3, 5.4, 5.6**
  - [ ]* 3.7 Write unit tests for keygen/sign/verify, invitation validation, and rotation
    - Cover tampered signatures, non-admin invitation issuer rejection, revoked-key rejection, and rotation retiring the old key.
    - _Requirements: 5.1, 5.2, 5.5, 5.6, 5.7_

- [ ] 4. `packages/core-state` — pure in-memory coordination engine
  - **Goal:** Implement the deterministic, dependency-free authority logic (revisions, locks,
    presence, intents, risk, sync, expiry, coalescing, data-minimization) that both host and agent embed.
  - [ ] 4.1 Implement session identity, canonical repo ID, and path normalization
    - Derive canonical `repoId` from SSH/HTTPS/`.git` remotes; normalize repository-relative paths
      (separators, `.`/`..`, `./`, platform-aware case key); build `session_key` hashing.
    - _Requirements: 10.1, 10.2, 10.3, 10.4; Design §9.1, §9.3_
  - [ ]* 4.2 Write property test — canonical repository ID is transport-independent
    - **Property 12: Canonical repository ID is transport-independent**
    - **Validates: Requirements 10.1**
  - [ ]* 4.3 Write property test — path normalization maps equivalents to one key
    - **Property 11: Path normalization maps equivalents to one key**
    - **Validates: Requirements 10.3, 10.4**
  - [ ] 4.4 Implement monotonic Event_Revision assignment with restart resume
    - Per-session `++counter` assignment guaranteeing uniqueness/strict order; resume above the
      max persisted revision on restore.
    - _Requirements: 8.1, 1.6; Design §4.5_
  - [ ]* 4.5 Write property test — Event_Revision monotonicity and total order
    - **Property 1: Event_Revision monotonicity and total order**
    - **Validates: Requirements 8.1, 1.6**
  - [ ] 4.6 Implement the ingest gate: idempotency, replay, and schema/permission checks
    - Apply an event at most once per `Event_ID` (returning the prior revision on duplicate), reject
      replays via the security counter/nonce logic, and validate schema + sender permission before
      any state change.
    - _Requirements: 7.4, 7.5, 7.7; Design §4.4_
  - [ ]* 4.7 Write property test — idempotency of duplicate Event_IDs
    - **Property 3: Idempotency of duplicate Event_IDs**
    - **Validates: Requirements 7.4**
  - [ ] 4.8 Implement the lock registry and presence registry
    - Acquire/release soft, coordination-required, and hard locks with holder checks
      (`NOT_LOCK_HOLDER`, `NO_ACTIVE_LOCK`); track presence started/editing/stopped per member/path.
    - _Requirements: 11.1–11.4, 12.1–12.8, 13.1–13.5, 14.1–14.4; Design §10.3, §10.4_
  - [ ] 4.9 Implement conflict resolution by earliest Event_Revision
    - Select the winner as the earliest assigned revision for contested locks and Planned_File_Creations;
      record every other claim as a concurrent claim with the winning member + revision; never use raw
      timestamps as the sole resolver.
    - _Requirements: 8.2, 8.3, 8.4, 12.4, 14.5, 18.1, 18.3; Design §10.2_
  - [ ]* 4.10 Write property test — conflict resolution is deterministic and order-independent
    - **Property 2: Conflict resolution is deterministic and order-independent**
    - **Validates: Requirements 8.2, 8.3, 8.4, 12.4, 14.5, 18.1, 18.3**
  - [ ] 4.11 Implement declared-intent lifecycle and planned-file-creation collision detection
    - Declare/update/withdraw/complete intents with ownership enforcement (`NOT_OWNER`), reconcile
      with real saves/creations, reclassify create→modify when a path already exists, and detect
      duplicate Planned_File_Creations; support file/folder/glob `Intent_Scope`.
    - _Requirements: 16.1–16.8, 17.1–17.5, 18.1–18.3, 32.1–32.5; Design §5.1, §10.2_
  - [ ] 4.12 Implement the rules-precedence resolver
    - Parse/validate `Repository_Rules_Config`, resolve a path's mode as most-restrictive-wins
      (`hard > coordination-required > soft`), default unmatched paths to soft, and fall back to
      all-soft on malformed config (never silently escalate).
    - _Requirements: 15.1–15.5; Design "Repository Rules Config Format", §6_
  - [ ]* 4.13 Write property test — rules precedence is most-restrictive-wins
    - **Property 10: Rules precedence is most-restrictive-wins**
    - **Validates: Requirements 15.3, 15.4**
  - [ ] 4.14 Implement risk classification, Risk_Map projection, and own-activity exclusion
    - Derive per-path `RiskLevel` from `resolveMode` + contention + dependency risk; build the
      Risk_Map with contributor identities and direct/indirect explanation paths; exclude the
      requesting member's own locks/intents; flag `acknowledgementRequired` for coordination-required.
    - _Requirements: 21.1–21.3, 22.1–22.5, 24.1–24.7, 31.5; Design §7.8, §10.1_
  - [ ]* 4.15 Write property test — a member's own activity is excluded from its own Risk_Map
    - **Property 13: A member's own activity is excluded from its own Risk_Map**
    - **Validates: Requirements 31.5**
  - [ ] 4.16 Implement registry serialize/deserialize and revision-counter restore
    - Serialize/deserialize Lock_Registry, Intent_Registry, and presence to an authoritative state
      snapshot; on restore resume the revision counter above the max persisted revision.
    - _Requirements: 1.5, 1.6, 9.5, 35.1; Design §5.2_
  - [ ]* 4.17 Write property test — registry persistence round-trip
    - **Property 7: Registry persistence round-trip**
    - **Validates: Requirements 1.5, 1.6, 9.5, 35.1**
  - [ ] 4.18 Implement reconnect sync-from-revision convergence
    - Produce incremental `sync.events` for `> fromRevision` and a full snapshot fallback; apply
      them on the agent side so cached state converges to authoritative state with no missed or
      re-applied events; clear staleness on completion.
    - _Requirements: 9.1–9.6, 33.4, 33.5; Design §4.6_
  - [ ]* 4.19 Write property test — reconnect synchronization converges
    - **Property 8: Reconnect synchronization converges**
    - **Validates: Requirements 9.2, 9.3, 9.4, 9.5, 33.4**
  - [ ] 4.20 Implement heartbeat tracking and stale lock/intent expiry sweep
    - Track last-seen heartbeat per device; the expiry sweep releases exactly the locks/intents whose
      holder's heartbeat is older than `Lock_Expiry_Interval`, leaving others intact, emitting removals.
    - _Requirements: 26.1–26.6; Design §5.2, §13.4_
  - [ ]* 4.21 Write property test — stale locks and intents expire deterministically
    - **Property 14: Stale locks and intents expire deterministically**
    - **Validates: Requirements 26.3**
  - [ ] 4.22 Implement coalescing and deduplication within the burst window
    - Coalesce a burst of presence/lock changes to at most one event per path equal to its final
      state and discard identical duplicate events per path/member; bound the outbound event rate.
    - _Requirements: 34.1, 34.2, 34.3, 34.4; Design §8.5_
  - [ ]* 4.23 Write property test — coalescing and deduplication preserve final per-path state
    - **Property 15: Coalescing and deduplication preserve final per-path state**
    - **Validates: Requirements 34.1, 34.2, 34.3**
  - [ ] 4.24 Implement the data-minimization filter and host-side rejection
    - Strip source contents, secrets, `.env` data, and absolute paths from any outbound message
      (metadata + normalized repo-relative paths only); reject inbound messages that violate this
      with `FORMAT_ERROR`.
    - _Requirements: 29.1–29.5; Design §7.2, §8.3_
  - [ ]* 4.25 Write property test — data-minimization invariant
    - **Property 9: Data-minimization invariant**
    - **Validates: Requirements 29.1, 29.2, 29.3, 29.4, 29.5**
  - [ ]* 4.26 Write unit tests for lock/intent/presence edge cases and error codes
    - Cover release-by-non-holder, release-with-no-lock, cross-branch non-conflict, coordination-required
      override missing reason (`OVERRIDE_REASON_REQUIRED`), and rename/move/delete path tracking.
    - _Requirements: 12.7, 12.8, 13.4, 21.3, 30.1–30.7_

- [ ] 5. `packages/dependency-analyzer` — metadata-only TS/JS analyzer
  - **Goal:** Build the pluggable, metadata-only dependency analysis that feeds indirect-risk detection.
  - [ ] 5.1 Define `LanguageAnalyzer` interface and the TS/JS import analyzer
    - Implement the `LanguageAnalyzer` interface and a TS/JS analyzer that extracts directed
      `Dependency_Edge`s (edge kinds) with confidence levels (high/medium/low/unknown) from import
      specifiers only — never file bodies.
    - _Requirements: 19.1, 19.2, 19.6; Design §7.5, §7.7_
  - [ ] 5.2 Implement manifest metadata, contract fingerprints, and the exclusion list
    - Extract `Package_Dependency_Metadata` and `Public_Contract_Fingerprint`s (hashes only); apply
      the always-excluded list (`node_modules`, build outputs, caches, `.git`, vendor, venv, secrets).
    - _Requirements: 19.2, 19.7, 29.2; Design §7.1, §7.6_
  - [ ] 5.3 Implement snapshot vs delta computation and graph serialize/deserialize
    - Build a full graph on first authorization, emit `dep.delta` on subsequent changes, avoid
      re-uploading a graph the host already holds at the same branch/base revision, and serialize/
      deserialize the graph preserving all five metadata categories.
    - _Requirements: 19.3, 19.4, 19.5, 20.1, 20.2, 20.3, 20.4; Design §7.3, §7.4_
  - [ ]* 5.4 Write property test — Dependency_Graph serialization round-trip
    - **Property 6: Dependency_Graph serialization round-trip**
    - **Validates: Requirements 20.4**
  - [ ]* 5.5 Write unit tests for confidence levels, exclusion list, and delta computation
    - Cover static→high / aliased→medium / dynamic→low|unknown, excluded folders never analyzed, and add/remove edge deltas.
    - _Requirements: 19.6, 19.7, 19.4_

- [ ] 6. Checkpoint — shared packages and pure logic
  - Ensure all `protocol`, `security`, `core-state`, and `dependency-analyzer` unit and property
    tests pass. Ask the user if questions arise.

- [ ] 7. `packages/mcp-server` — Local_MCP_Server and the 12 tools
  - **Goal:** Expose the strictly-local MCP surface wired to the core-state engine through the agent.
  - [ ] 7.1 Scaffold the MCP server and the `McpEnvelope`
    - Build on `@modelcontextprotocol/sdk` (stdio/local transport); implement the common `McpEnvelope`
      carrying `connection` and `staleness` on every response.
    - _Requirements: 4.1, 4.7, 33.2; Design §3.4_
  - [ ] 7.2 Implement the 12 MCP tools wired to core-state via the agent
    - Implement `get_risk_map`, `get_dependency_impact`, `get_dependencies`, `get_dependents`,
      `declare_intent`, `update_intent`, `withdraw_intent`, `acquire_lock`, `release_lock`,
      `subscribe_to_coordination_updates`, `get_connection_status`, `get_project_session_status`,
      including offline-queued/rejected behavior without falsely reporting host acceptance.
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 12.1–12.8, 16.1–16.8, 23.1–23.5, 24.1–24.7, 25.1, 31.5, 32.1, 32.4, 33.1; Design §3.4_
  - [ ]* 7.3 Write integration tests for MCP tool round-trips
    - Exercise query tools, a mutating tool, and an offline-queued mutation through the MCP SDK.
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.8, 33.1_
  - [ ]* 7.4 Write unit tests for the envelope, error mapping, and offline behavior
    - Cover `McpEnvelope` connectivity/staleness fields, `ErrorCode` mapping, and `OFFLINE_QUEUED` results.
    - _Requirements: 4.7, 4.8, 33.2_

- [ ] 8. `apps/host` — CoordinationHost server
  - **Goal:** Assemble the definitive authority: WSS server, auth, ingest, persistence, broadcast,
    sync, expiry, diagnostics, and audit, reusing the core-state engine.
  - [ ] 8.1 Implement the WSS/TLS server with configurable Host_URL
    - Listen for agent connections at the configured `Host_URL` within 10s over WSS/TLS; no hardcoded address.
    - _Requirements: 1.1, 6.1, 6.2, 6.3; Design §2.2, §4.1_
  - [ ] 8.2 Implement the authentication handshake
    - Ed25519 challenge-response (`auth.hello`/`auth.challenge`/`auth.response`/`auth.ok|auth.error`);
      validate device identity, membership, invitation validity, revocation, and message-format version.
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 7.6, 10.7; Design §4.1_
  - [ ] 8.3 Implement the ingest pipeline and revision assignment
    - Verify signatures, enforce idempotency and replay protection, validate schema/permission,
      assign monotonic Event_Revisions via core-state, and reject data-minimization violations.
    - _Requirements: 7.1–7.7, 8.1–8.5, 29.5; Design §4.4, §4.5_
  - [ ] 8.4 Implement the SQLite `Store` behind the DAO with restart recovery
    - Implement the `Store` interface over SQLite (tables per design), durable event/audit
      persistence, and restore of authoritative state + revision counters on restart; keep the DAO
      seam so PostgreSQL can replace it later unchanged.
    - _Requirements: 1.5, 1.6, 1.8; Design §5.2_
  - [ ] 8.5 Implement broadcast, subscriptions, and session scoping
    - Broadcast each accepted `Coordination_Update` (carrying its Event_Revision) only to agents
      authorized for the same session; isolate all state by `session_key`; reject events for
      unauthorized sessions.
    - _Requirements: 1.2, 1.4, 10.2, 10.7, 25.1–25.6; Design §9.5_
  - [ ] 8.6 Implement sync-from-revision
    - Serve `sync.events` for revisions `> fromRevision` and a `sync.snapshot` fallback via core-state.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5; Design §4.6_
  - [ ] 8.7 Implement heartbeats, expiry, and audit records
    - Track heartbeats, run the stale lock/intent expiry sweep, and write durable Audit_Records
      (member, device, action, revision, time, Override_Reason) with no source content.
    - _Requirements: 26.1–26.5, 28.1–28.4; Design §5.2_
  - [ ] 8.8 Implement health, diagnostics, and peer-connectivity reporting
    - Expose health/diagnostics endpoints reporting operational + connectivity metadata only (no
      source/secrets).
    - _Requirements: 27.1–27.5; Design §3.1_
  - [ ]* 8.9 Write integration tests for the host over real WSS + SQLite
    - Cover handshake, ingest→broadcast, sync convergence, restart recovery, and revoked/absent-device rejection.
    - _Requirements: 1.1, 1.5, 1.6, 5.4, 7.4, 8.1, 9.3_
  - [ ]* 8.10 Write unit tests for the DAO and revision-counter atomicity
    - Cover atomic `nextRevision`, `hasAppliedEventId`, and typed error codes.
    - _Requirements: 8.1, 1.8, 7.4_

- [ ] 9. `apps/agent` — CoordinationAgent
  - **Goal:** Assemble the per-user agent: one WSS connection, loopback-only Local_API, embedded
    MCP server, folder watcher, encrypted cache, reconnect/re-assert, and Windows packaging.
  - [ ] 9.1 Implement the WSS client with backoff and Offline_State
    - Single outbound persistent WSS connection with exponential backoff; enter Offline_State on
      loss (never claim hard-lock safety), report connectivity.
    - _Requirements: 2.3, 6.1–6.6, 33.1, 33.3; Design §3.2, §8.4_
  - [ ] 9.2 Implement the Local_API (named pipe + loopback WS + token fallback)
    - Windows named pipe with an authenticated loopback WebSocket fallback, both requiring a
      per-session `Local_Auth_Token`; reject non-loopback origins and unauthorized subscriptions;
      emit a startup error and refuse clients if it cannot bind.
    - _Requirements: 2.4, 2.5, 2.9, 25.6; Design §3.3, §8.3_
  - [ ] 9.3 Embed the MCP server and implement multi-client fan-in
    - Serve the embedded `mcp-server` through the Local_API, wire it to the core-state engine, and
      coordinate multiple local clients under one device identity with a single consistent host view.
    - _Requirements: 2.6, 31.1–31.5; Design §3.2_
  - [ ] 9.4 Implement the filesystem watcher on the Authorized_Folder
    - Watch only the Authorized_Folder (never scan elsewhere, never modify files); reconcile saves,
      creations, renames/moves, and deletions into presence/intents/dependency-edge updates.
    - _Requirements: 2.7, 2.8, 17.1–17.5, 30.1–30.7; Design §7.6_
  - [ ] 9.5 Implement the local encrypted cache, reconnect sync, and re-assert
    - Persist coordination state in a local encrypted cache (no source/secrets); on reconnect run
      sync-from-revision, re-assert still-held locks/intents, and clear staleness; apply coalescing.
    - _Requirements: 9.6, 33.4, 33.5, 34.1–34.4, 35.1–35.4; Design §4.6, §8.5_
  - [ ] 9.6 Integrate key storage and rules-config loading
    - Use the `security` credential store for the Device_Key (fail closed on
      `SECURE_STORAGE_UNAVAILABLE`); load/validate `Repository_Rules_Config` and the manual
      session fallback.
    - _Requirements: 5.1, 5.8, 5.9, 10.6, 15.1–15.5; Design §8.2, §9.4_
  - [ ] 9.7 Package the agent as a Windows executable with login-startup registration
    - Build a Windows executable via Node SEA (fallback `pkg`); register per-user login startup via
      the HKCU Run key / Startup folder without requiring administrator privileges.
    - _Requirements: 2.1, 2.2; Design "Project Structure" (Packaging)_
  - [ ]* 9.8 Write integration tests for connect/offline/reconnect and Local_API
    - Cover connect→offline→reconnect convergence, Local_API loopback-only rejection, and
      watcher-driven rename/delete reconciliation.
    - _Requirements: 2.5, 6.4, 6.6, 9.4, 30.1_
  - [ ]* 9.9 Write unit tests for backoff, cache encryption, and multi-client fan-in
    - Cover backoff schedule, cache encrypt/decrypt with no plaintext source, and own-view consolidation.
    - _Requirements: 6.4, 31.1, 35.1, 35.4_

- [ ] 10. Checkpoint — host and agent integration
  - Ensure host and agent integration tests pass end-to-end over a real local WSS connection. Ask
    the user if questions arise.

- [ ] 11. `apps/vscode-extension` — Editor_Extension
  - **Goal:** Deliver the VS Code client that talks only to the local agent, emits editor events,
    renders coordination state, and enforces hard-stop.
  - [ ] 11.1 Implement Local_API-only connectivity and heartbeats
    - Connect to the local CoordinationAgent through the Local_API only (never to the host); send
      periodic heartbeats to the agent.
    - _Requirements: 3.1, 26.6; Design §3.5_
  - [ ] 11.2 Emit the 8 editor events within 2 seconds
    - Detect and send `workspace_opened`, `file_opened`, `active_editor_changed`, `editing_started`,
      `file_saved`, `file_closed`, `file_renamed`, `file_deleted` to the agent within 2s.
    - _Requirements: 3.2; Design §3.5_
  - [ ] 11.3 Render coordination state and offline/stale indicators
    - Within 2s of a Coordination_Update, display per-path soft/coordination-required/hard locks,
      presence, intents, planned file creations, and indirect dependency risk with contributing
      member identity; show an offline/stale indicator.
    - _Requirements: 3.3, 3.4, 3.6, 33.3; Design §3.5_
  - [ ] 11.4 Enforce hard-stop for cooperating edits
    - Reject edits to a hard-mode path with a valid winning lock held by another member (cooperative
      enforcement, never OS-level), reporting the holder.
    - _Requirements: 3.5, 14.1, 14.2, 14.3; Design §10.4_
  - [ ]* 11.5 Write tests for event emission, rendering, hard-stop, and offline indicator
    - Cover event emission timing, update rendering, hard-stop decision, and offline banner.
    - _Requirements: 3.2, 3.3, 3.5, 3.6_

- [ ] 12. `tests/simulation` — 5-agent local multi-agent simulation
  - **Goal:** Validate end-to-end coordination across one host and five in-process agents against
    the design's eight scenarios.
  - [ ] 12.1 Build the 5-agent simulation harness
    - Wire one CoordinationHost + five in-process simulated CoordinationAgents on a single machine.
    - _Requirements: 6.7; Design §13.4_
  - [ ] 12.2 Implement scenarios 1–4 (presence, declared intent, direct conflict, indirect conflict)
    - Presence propagation to peers; declared-intent broadcast/reconciliation with saves; direct
      conflict deterministic winner by revision; indirect dependency conflict via a Dependency_Edge.
    - _Requirements: 11.1, 17.1, 21.1, 22.1; Design §13.4 (scenarios 1–4)_
  - [ ] 12.3 Implement scenarios 5–8 (lock acquire/release, stale expiry, reconnect sync, unauthorized rejection)
    - Lock acquire/release happy path; stale lock expiry after missed heartbeats; reconnect sync
      convergence from a known revision; unauthorized/revoked-device rejection.
    - _Requirements: 12.1, 26.3, 9.4, 5.4; Design §13.4 (scenarios 5–8)_

- [ ] 13. Final checkpoint — full suite green
  - Ensure all unit, property, integration, and simulation tests pass across the monorepo. Ask the
    user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks (unit, integration, property) and can be
  skipped for a faster MVP; core implementation sub-tasks are never optional.
- Each task references specific requirement clauses (and design sections/Property numbers) for traceability.
- All 15 correctness properties are covered: P1 (4.5), P2 (4.10), P3 (4.7), P4 (3.5), P5 (3.6),
  P6 (5.4), P7 (4.17), P8 (4.19), P9 (4.25), P10 (4.13), P11 (4.3), P12 (4.2), P13 (4.15),
  P14 (4.21), P15 (4.23). Each property test uses `fast-check` with ≥100 iterations and the
  standard `Feature/Property` tag.
- Requirement 36 (Future) is intentionally not implemented; the `Store` DAO, `LanguageAnalyzer`
  interface, and transport-agnostic envelope are the clean extension points left for it.
- This workflow produces only the design and planning artifacts. Implementation begins by opening
  `tasks.md` and clicking "Start task" next to a task item.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4", "2.5", "3.1", "3.4"] },
    { "id": 4, "tasks": ["3.2", "3.3", "5.1"] },
    { "id": 5, "tasks": ["3.5", "3.6", "3.7", "5.2"] },
    { "id": 6, "tasks": ["4.1", "5.3"] },
    { "id": 7, "tasks": ["4.2", "4.3", "4.4", "5.4", "5.5"] },
    { "id": 8, "tasks": ["4.5", "4.6", "4.8", "4.12"] },
    { "id": 9, "tasks": ["4.7", "4.9", "4.11", "4.13"] },
    { "id": 10, "tasks": ["4.10", "4.14", "4.16", "4.20", "4.22", "4.24"] },
    { "id": 11, "tasks": ["4.15", "4.17", "4.18", "4.21", "4.23", "4.25", "4.26"] },
    { "id": 12, "tasks": ["4.19"] },
    { "id": 13, "tasks": ["7.1", "8.1"] },
    { "id": 14, "tasks": ["7.2", "8.2", "9.1"] },
    { "id": 15, "tasks": ["8.3", "9.2"] },
    { "id": 16, "tasks": ["8.4", "9.3"] },
    { "id": 17, "tasks": ["8.5", "9.4"] },
    { "id": 18, "tasks": ["8.6", "9.5"] },
    { "id": 19, "tasks": ["8.7", "9.6"] },
    { "id": 20, "tasks": ["8.8", "9.7", "11.1"] },
    { "id": 21, "tasks": ["7.3", "7.4", "8.9", "8.10", "9.8", "9.9", "11.2", "11.3", "11.4"] },
    { "id": 22, "tasks": ["11.5", "12.1"] },
    { "id": 23, "tasks": ["12.2", "12.3"] }
  ]
}
```
