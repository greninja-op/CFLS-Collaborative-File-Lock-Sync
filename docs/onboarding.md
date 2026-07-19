# Onboarding: joining a shared repo session across laptops

> How a team goes from "clone the repo" to "CFLS is Online" on separate laptops,
> using the `cfls` CLI (`@cfls/cli`). Related docs:
> [deployment.md](./deployment.md) · [architecture.md](./architecture.md) ·
> [threat-model.md](./threat-model.md)

## What CFLS does and does not share

CFLS shares **coordination metadata only** — presence, soft/hard locks, declared
intents, and risk. It does **not** move file contents. Your **files are shared
through git**: everyone clones the same remote, and you `push`/`pull` as usual.

Because coordination is keyed by the **git remote** (canonical `repoId`) and uses
**repository-relative paths**, it does not matter where each teammate keeps the
repo on disk or what the folder is named. `C:\work\app` on one laptop and
`~/dev/app` on another coordinate as the same session, as long as they share the
same git `origin` and branch.

Session identity is the tuple `(repoId, teamId, branch, baseRevision)`. The `cfls`
tool derives it automatically:

- `repoId` — canonical form of `git remote get-url origin`
- `teamId` — configured (`--team`), defaulting to `default-team`
- `branch` — `git rev-parse --abbrev-ref HEAD`
- `baseRevision` — `git rev-parse HEAD`

If git metadata is unavailable, `cfls` falls back to a manual
`.coordination/session.json` (`{ repoId, teamId, branch, baseRevision }`) and
errors clearly if neither source exists.

> The **invitation** a teammate receives embeds the authoritative session, so the
> agent always coordinates against exactly the session the host accepts.

## Roles

- **Team admin** — runs the CoordinationHost and issues invitations. Holds the
  team's admin signing key (stored in the OS secret store / encrypted-file
  fallback, never on disk in plaintext, never committed).
- **Teammate** — runs a local CoordinationAgent and the VS Code extension.

## Prerequisites

- Node.js ≥ 20 and the built CLI (`pnpm -r build`, then use `cfls` from
  `apps/cli/dist/index.js`, or `pnpm --filter @cfls/cli exec cfls …`).
- Everyone has cloned the **same git remote** and checked out the **same branch**.
- The admin's host must be reachable from each teammate (see
  [deployment.md](./deployment.md) for laptop vs VPS reachability).

## End-to-end flow

### 1. Admin: one-time key + host setup

```bash
# Create and securely store the team admin key; registers its public key in ~/.cfls/host.json
cfls admin-init --team my-team

# Start the CoordinationHost for this repo's session (run from inside the repo)
cfls host --url wss://0.0.0.0:8730 --insecure-tls
#   dev uses a self-signed cert (teammates pass --insecure-tls)
#   production: pass --cert <pem> --key <pem> (or set CFLS_TLS_CERT / CFLS_TLS_KEY)
```

`cfls host` prints the reachable `Host_URL` and the session it is serving. Keep it
running (Ctrl+C stops it). For an always-on setup, deploy the host on a VPS — see
[deployment.md](./deployment.md).

### 2. Teammate: register this device and share its public key

```bash
# From inside the cloned repo
cfls id                     # prints this device's Device_Public_Key + deviceId
# (optional) also record the host + your name for later:
cfls join --host wss://<host-ip>:8730 --name alice --team my-team
```

Send the printed **Device_Public_Key** to the admin (chat, email — it is public,
not a secret).

### 3. Admin: issue an invitation for that device

```bash
# Run from inside the repo (same session the host serves)
cfls invite alice <alice-device-public-key>
```

This prints a **base64 invitation string**. Send it back to the teammate.

### 4. Teammate: connect and go online

```bash
cfls connect <invitation-string>     # validates + stores the invitation
cfls agent --insecure-tls            # starts the local agent (Ctrl+C to stop)
```

`cfls agent`:

- loads this device's key from the secret store,
- watches the repo root as the Authorized_Folder,
- loads team rules from `.coordination/rules.json` (or all-soft by default),
- picks a fixed loopback Local_API port (default `8750`, override `--local-port`),
- writes `.coordination/local-api.json` (`{ url, token }`) so the VS Code
  extension **auto-discovers** the agent with zero manual settings.

### 5. Teammate: install the extension and open the repo

- Install the CFLS extension (`.vsix` — see the extension's `package:vsix`
  script) into VS Code.
- Open the repo folder. With `cfls agent` running, the extension reads
  `.coordination/local-api.json`, connects to the local agent, and the status bar
  goes **Online**. No `cfls.localApi.*` settings needed.

When two teammates edit the same tracked file, each sees the other's presence,
soft locks, and (where configured) hard-lock coordination live.

## Files this creates

| Path | Scope | Committed? | Contents |
| --- | --- | --- | --- |
| `~/.cfls/host.json` | per-machine (admin) | no | authorized admin public keys + teamId |
| OS secret store / `~/.cfls` encrypted file | per-machine | no | admin private key, device private key |
| `.coordination/agent.json` | per-repo, per-machine | no (gitignored) | hostUrl, memberName, teamId, invitation |
| `.coordination/local-api.json` | per-repo, per-machine | no (gitignored) | loopback Local_API url + per-session token |
| `.coordination/session.json` | per-repo | optional | manual session fallback when git is unavailable |
| `.coordination/rules.json` | per-repo | **yes** (team-shared) | Repository_Rules_Config |

Secrets never land in `.coordination/*`. Private keys live only in the OS secret
store or the encrypted-file fallback under `~/.cfls`. The `.gitignore` already
excludes `.cfls/`, `.coordination/local-api.json`, `.coordination/agent.json`, and
`.coordination/.cache/`.

## Troubleshooting

- **Status bar stays Offline** — is `cfls agent` running in the repo? Does
  `.coordination/local-api.json` exist? Is the host reachable at the configured
  `Host_URL`?
- **Handshake rejected / "Invitation is for a different session"** — the admin
  and teammate must be on the **same branch/commit** so the session matches, and
  the invitation must be for the public key from `cfls id` on **that** machine.
- **"No secure secret store is available"** — the agent fails closed by design; a
  usable OS credential store or the encrypted-file fallback under `~/.cfls` is
  required.
- **Self-signed TLS** — dev hosts use a self-signed certificate, so teammates must
  pass `--insecure-tls`. Use a real certificate in production (see
  [deployment.md](./deployment.md)).
