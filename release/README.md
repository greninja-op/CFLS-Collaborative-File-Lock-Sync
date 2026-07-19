# CFLS release artifacts

This folder holds the two distributable artifacts. Both are **built and verified
working**; see how to (re)build each below.

| Artifact | Size | In git? | What it is |
|----------|------|---------|------------|
| `cfls-coordination.vsix` | ~33 KB | ✅ committed | The VS Code / Kiro editor extension, self-contained (no `node_modules` needed). |
| `cfls.exe` | ~89 MB | ❌ not committed | The standalone `cfls` CLI as a single Windows executable (Node runtime baked in). Runs with no Node install. |

> **Why `cfls.exe` is not committed:** it's an 89 MB binary. Committing it would
> bloat the git history permanently (every clone would download it forever, even
> after deletion). It is trivial to rebuild (one command, below), and the proper
> home for a large binary is a **GitHub Release asset** (free). Ask if you want it
> published as a Release.

---

## The extension — `cfls-coordination.vsix`

**Install it** (into VS Code and/or Kiro):

```
code --install-extension release/cfls-coordination.vsix --force
kiro --install-extension release/cfls-coordination.vsix --force
```

That's all a teammate needs — no marketplace, no publishing. Just send them this
`.vsix` file and the command above.

**Rebuild it** after changing the extension source:

```
pnpm -C apps/vscode-extension package:vsix
# → apps/vscode-extension/vsix-pkg/cfls-coordination.vsix
```

Then copy it here: `Copy-Item apps/vscode-extension/vsix-pkg/cfls-coordination.vsix release/`.

**Verified:** packages cleanly (5 files, self-contained bundle) and installs into
both VS Code and Kiro (`cfls.cfls-coordination` shows in `--list-extensions`).

---

## The CLI — `cfls.exe`

A single Windows executable exposing every `cfls` command
(`admin-init` / `host` / `id` / `invite` / `join` / `connect` / `agent` /
`sync` / `clone`). No Node install required on the target machine.

**Build it:**

```
pnpm -C apps/cli package:win
# → apps/cli/dist-exe/cfls.exe   (then copy to release/ if you want)
```

**Use it** (examples):

```
cfls.exe help
cfls.exe id
cfls.exe admin-init --team myteam
cfls.exe host --url wss://0.0.0.0:8730
cfls.exe agent --insecure-tls
```

**Verified working:** `help`, `id` (device key + secret store), `admin-init`
(secret store write), and `host` (opens SQLite via `node:sqlite` and binds the
`wss://` TLS server) all run correctly from the packaged exe.

**How it's built:** Node's Single Executable Applications (SEA) feature — a
single self-contained CommonJS bundle (`tsup.exe.config.ts`) is embedded into a
copy of the Node binary via `postject` (`apps/cli/scripts/build-exe.mjs`). The
build defines `import.meta.url` to a valid file URL so `createRequire(...)`-based
Node built-in loading (e.g. `node:sqlite`) keeps working inside the CJS bundle.

> Windows note: the packaged exe carries an invalidated Node code signature, so
> SmartScreen/Defender may prompt on first run of an unsigned internal build.
> That's expected for an unsigned executable; code-signing is a separate,
> optional release step.
