# Testing Strategy & Correctness Properties

> Living testing doc for **Collaborative File Lock Sync (Host-Based MVP)**.
> Seeded from the design's "Testing Strategy" and "Correctness Properties" sections.
> Related docs: [architecture.md](./architecture.md) · [protocol.md](./protocol.md) ·
> [threat-model.md](./threat-model.md)

## Dual Approach

- **Unit tests:** concrete examples, edge cases, error conditions (glob precedence, path
  normalization pairs, error codes, MCP tool wiring).
- **Property-based tests:** universal properties across generated inputs (see below). Library:
  **`fast-check`** (TypeScript). Each property test runs **≥100 iterations** and is tagged
  `Feature: collaborative-file-lock-sync, Property N: <text>`.
- **Integration tests:** real WSS handshake, SQLite store, agent↔host ingest/broadcast/sync,
  MCP SDK tool round-trips (1–3 examples each).
- **Simulation:** local multi-agent scenario harness.

## What PBT Covers (pure logic layer)

Event_Revision monotonicity & total order; conflict-resolution determinism;
serialize/deserialize round-trips for Lock/Intent registries and Dependency_Graph;
idempotency of duplicate Event_IDs; replay rejection; reconnect sync convergence; and the
data-minimization invariant. These target `packages/core-state`, `packages/protocol`,
`packages/dependency-analyzer`, and the `packages/security` signing/replay logic.

## What PBT Does NOT Cover

WSS/TLS transport wiring, VS Code UI rendering, OS credential store integration, filesystem
watcher, executable packaging, and login-startup registration — these use
integration/smoke/example tests.

## Local Multi-Agent Simulation (5 simulated agents)

A single host + 5 in-process simulated agents on one machine exercising eight scenarios:

1. **Presence** propagation to peers.
2. **Declared intent** broadcast and reconciliation with saves.
3. **Direct conflict** on the same path — deterministic winner by revision.
4. **Indirect dependency conflict** via a `Dependency_Edge`.
5. **Lock acquire/release** happy path.
6. **Stale lock expiry** after missed heartbeats.
7. **Reconnect sync** convergence from a known revision.
8. **Unauthorized-device rejection** (revoked/absent key).

## Correctness Properties

Each property is implemented as a single `fast-check` property test, ≥100 iterations, tagged
`Feature: collaborative-file-lock-sync, Property N: <text>`, and placed beside the package
that owns the logic.

### Property 1: Event_Revision monotonicity and total order
For any sequence of accepted coordination events within a single Repository_Session, the
assigned Event_Revisions are strictly increasing, unique, and form a total order; after a
simulated restart the next assigned revision is greater than every previously assigned
revision for that session. **Validates: Requirements 8.1, 1.6**

### Property 2: Conflict resolution is deterministic and order-independent
For any set of competing claims (Soft_Locks, Coordination_Required/Hard locks, or
Planned_File_Creations) on the same scope under the same Branch_Context, the winner is
exactly the claim with the earliest assigned Event_Revision, every other claim is recorded as
a concurrent claim, and the outcome is identical for all arrival-order permutations — even
when raw client timestamps contradict the revision order.
**Validates: Requirements 8.2, 8.3, 8.4, 12.4, 14.5, 18.1, 18.3**

### Property 3: Idempotency of duplicate Event_IDs
For any Signed_Event applied to the authoritative state, submitting the same Event_ID any
number of additional times applies it at most once, leaves the authoritative state unchanged
after the first application, and returns the originally assigned Event_Revision each time.
**Validates: Requirements 7.4**

### Property 4: Replay rejection leaves state unchanged
For any device event stream, an event whose replay counter is less than or equal to the
highest counter already accepted for that device (or whose nonce is reused) is rejected, and
the authoritative coordination state is identical to the state before the replayed event was
received. **Validates: Requirements 7.5**

### Property 5: Only authentically signed, admitted events mutate state
For any received event, the authoritative state changes if and only if the event's signature
verifies against an admitted, non-revoked Device_Public_Key in the Membership_Registry;
events with invalid signatures or from revoked/absent keys leave the state unchanged.
**Validates: Requirements 7.2, 7.3, 5.4, 5.6**

### Property 6: Dependency_Graph serialization round-trip
For any valid Dependency_Graph, deserializing its serialized form yields an equivalent graph
preserving all five metadata categories (Repository_Snapshot_Metadata,
Package_Dependency_Metadata, Module_Dependency_Metadata, Public_Contract_Fingerprints, and
Change_Delta_Metadata). **Validates: Requirements 20.4**

### Property 7: Registry persistence round-trip
For any authoritative Lock_Registry and Intent_Registry state, restoring from its persisted
form produces an equivalent state, and the restored revision counter resumes above the
maximum persisted Event_Revision. **Validates: Requirements 1.5, 1.6, 9.5, 35.1**

### Property 8: Reconnect synchronization converges
For any authoritative event log and any agent-held highest-applied revision, after the agent
applies the host's incremental `sync.events` (or a full `sync.snapshot` when incremental is
unavailable), the agent's cached coordination state equals the host's authoritative state for
that session, with no missed or re-applied events.
**Validates: Requirements 9.2, 9.3, 9.4, 9.5, 33.4**

### Property 9: Data-minimization invariant
For any agent input — including files and events containing source contents, secrets, `.env`
data, or absolute filesystem paths — every message the agent serializes for transmission to
the host contains only coordination/Dependency_Graph metadata with normalized
repository-relative paths and none of the excluded content.
**Validates: Requirements 29.1, 29.2, 29.3, 29.4, 29.5**

### Property 10: Rules precedence is most-restrictive-wins
For any Repository_Rules_Config and repository-relative path, the resolved Risk_Level mode
equals the most restrictive mode among all matching globs (ordering hard >
coordination-required > soft), defaulting to soft when no glob matches, and the result is
independent of rule ordering. **Validates: Requirements 15.3, 15.4**

### Property 11: Path normalization maps equivalents to one key
For any set of spellings of the same repository-relative path (differing by separator style,
`./` prefixes, `..` segments, or case on case-insensitive platforms), normalization produces
a single canonical key so the same file is never treated as two distinct paths.
**Validates: Requirements 10.3, 10.4**

### Property 12: Canonical repository ID is transport-independent
For any SSH, HTTPS, or `.git`-suffixed remote URL variants that denote the same repository,
the derived canonical repository ID is identical. **Validates: Requirements 10.1**

### Property 13: A member's own activity is excluded from its own Risk_Map
For any coordination state and any requesting Team_Member, the Risk_Map served to that
member's AI_Agent contains no contributor entry attributable to that same member's own active
locks or Declared_Intents. **Validates: Requirements 31.5**

### Property 14: Stale locks and intents expire deterministically
For any coordination state and clock, the expiry sweep releases exactly the locks and
Declared_Intents held by devices whose most recent Heartbeat is older than the
Lock_Expiry_Interval, and leaves all others intact. **Validates: Requirements 26.3**

### Property 15: Coalescing and deduplication preserve final per-path state
For any burst of Presence_Events and lock changes within the coalescing window, the coalesced
output contains at most one event per repository-relative path equal to that path's final
state, and identical duplicate events for the same path and Team_Member are discarded.
**Validates: Requirements 34.1, 34.2, 34.3**

## Property → Task Map

Each property maps to a single `fast-check` test sub-task in the implementation plan:

| Property | Task | Property | Task |
|---|---|---|---|
| P1 | 4.5 | P9 | 4.25 |
| P2 | 4.10 | P10 | 4.13 |
| P3 | 4.7 | P11 | 4.3 |
| P4 | 3.5 | P12 | 4.2 |
| P5 | 3.6 | P13 | 4.15 |
| P6 | 5.4 | P14 | 4.21 |
| P7 | 4.17 | P15 | 4.23 |
| P8 | 4.19 | | |
