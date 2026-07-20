# Codex build task — CoordinationHost live web dashboard

**Goal:** add a read-only, auto-refreshing **web dashboard** served directly by the
CoordinationHost that shows, live, the whole team's coordination state: which
sessions exist, who is connected, which files are locked and by whom, who is
editing what, and planned file creations. This is genuine core functionality and
a strong visual for a demo.

**Constraints (must hold):**

- **Metadata only** — never expose file contents, keys, tokens, or invitations.
  Only coordination facts (paths, member names, lock modes, revisions, counts).
- TypeScript **strict**, ESM, match the existing code style and JSDoc tone in
  `apps/host/src`.
- **Do not break** the existing `/health` and `/diagnostics` endpoints, the WSS
  handshake, ingest, broadcast, or any current tests.
- Keep the whole suite green and typecheck clean.

---

## Where it fits (integration points — read these first)

- `apps/host/src/server.ts` — the `CoordinationServer`. It already runs an
  `https` server and routes GET `/health` and `/diagnostics` in `handleHttp(req,res)`.
  Add the new routes here. It already has private helpers `connectedDevices(session)`
  and `uptimeSeconds()`, and a `diagnostics()` method — reuse/extend them.
- `apps/host/src/authority.ts` — `CoordinationAuthority`. Use `authority.sessions()`
  (returns `SessionId[]`) and `authority.snapshot(session)` (has `highestRevision`
  and the active coordination entries). **Read this file and `store.ts` to find the
  exact shape** of the snapshot / entries (locks, presence, intents/planned
  creations, each entry's `member`, `path`, `mode`, `eventRevision`). Do not guess
  field names — use the real ones.
- `packages/core-state` and `packages/protocol` — the shared types for locks,
  presence, `SessionId`, `CoordinationUpdate`, etc. Import types from `@cfls/protocol`.

## What to build

### 1. New module `apps/host/src/dashboard.ts`

Export two things:

- `buildDashboardState(input): DashboardState` — a **pure** function that maps the
  authority's sessions + snapshots + connected-device lists into a serializable
  shape. Keep it pure (take the data in as arguments) so it is unit-testable
  without a running server. Shape roughly:

  ```ts
  interface DashboardState {
    uptimeSeconds: number;
    generatedAt: string; // ISO timestamp
    sessions: Array<{
      repoId: string;
      teamId: string;
      branch: string;
      highestRevision: number;
      connectedDevices: string[]; // deviceIds already connected
      locks: Array<{
        path: string;
        holder: string;
        mode: "soft" | "hard";
        eventRevision: number;
      }>;
      presence: Array<{ member: string; path: string }>;
      plannedCreations: Array<{ member: string; path: string }>;
    }>;
  }
  ```

  (Adjust field names to whatever the real snapshot exposes; derive `mode` from the
  rules if the snapshot only stores paths — check how the agent's view / core-state
  resolves lock mode and mirror that, or omit `mode` if not available server-side.)

- `renderDashboardHtml(): string` — returns a **self-contained HTML page** (inline
  CSS + a small inline `<script>`, no external build). The page:
  - fetches `/api/coordination` every ~2s and renders it,
  - dark theme, clean cards per session, an "online" dot per connected device,
  - a table of active locks (path · holder · mode), a list of who's editing what
    (presence), and planned creations,
  - shows uptime + highest revision + a "last updated" time,
  - has friendly empty states ("No active sessions", "No locks held"),
  - degrades gracefully if the API call fails (show "reconnecting…").

### 2. Wire routes in `server.ts` `handleHttp`

- `GET /` and `GET /dashboard` → `200 text/html`, body = `renderDashboardHtml()`.
- `GET /api/coordination` → `200 application/json`, body = `buildDashboardState(...)`
  built from `this.authority` + per-session `this.connectedDevices(session)` +
  `this.uptimeSeconds()`.
- Leave `/health` and `/diagnostics` exactly as they are; unknown routes still 404.

### 3. Security note (implement the simple version)

The dashboard exposes coordination **metadata** to anyone who can reach the host's
HTTP port. Add a config flag to gate it:

- Extend `HostConfig`/`HostConfigInput` in `apps/host/src/config.ts` with
  `dashboard?: boolean` (**default `true`**).
- When `false`, `/` `/dashboard` `/api/coordination` return `404` (dashboard off).
- Surface it in the CLI later is optional; just wire the config + default here.
  Add a one-line note to `docs/features.md` under a new "Host dashboard" bullet.

## Tests (add; keep existing green)

- Unit-test `buildDashboardState` with a fake authority/snapshot: asserts it maps
  sessions, locks, presence, connected devices, and never includes secret fields.
- Extend the existing host server test (see `apps/host/src/*.test.ts` / test harness)
  to assert:
  - `GET /dashboard` returns `200` and `content-type: text/html`,
  - `GET /api/coordination` returns `200` JSON with a `sessions` array,
  - when `dashboard: false`, those routes return `404`.
- `renderDashboardHtml()` returns a non-empty string containing `<!DOCTYPE html>`.

## Definition of done

- `pnpm -C apps/host typecheck` clean.
- `pnpm -C apps/host test --run` green (new + existing).
- `pnpm -r build` succeeds.
- Manually: start a host, open `https://localhost:8730/dashboard` in a browser
  (accept the self-signed cert), see live sessions/locks update as an agent edits.
- No file contents, keys, tokens, or invitations appear anywhere in the output.

## Suggested commit message

`Add read-only live coordination dashboard served by the host (/dashboard + /api/coordination), gated by dashboard config flag; metadata-only; tests`
