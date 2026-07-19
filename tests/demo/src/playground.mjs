/**
 * Interactive single-laptop PLAYGROUND.
 *
 * Boots ONE real CoordinationHost and THREE real CoordinationAgents — "alice",
 * "bob", "carol" — each on a FIXED loopback Local_API port, each watching its
 * own workspace folder under `playground/`. Into every workspace it writes a
 * `.vscode/settings.json` pre-filled with that agent's Local_API URL + token,
 * so a VS Code window opened on that folder auto-connects to the right agent.
 *
 * Then it stays running so you can open the folders in separate VS Code windows
 * (with the CFLS extension loaded) and watch presence/locks/intents appear as
 * you edit. Press Ctrl+C to stop everything.
 *
 * Run (after `pnpm -r build`):
 *   pnpm playground
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CoordinationAgent, generateLocalAuthToken } from "@cfls/agent";
import { ALL_SOFT_CONFIG } from "@cfls/core-state";
import { startHost } from "@cfls/host";
import { deriveDeviceId, generateDeviceKey, issueInvitation } from "@cfls/security";

const HERE = dirname(fileURLToPath(import.meta.url));
// playground/ lives at the repo root (tests/demo/src -> ../../../playground).
const PLAYGROUND_ROOT = join(HERE, "..", "..", "..", "playground");

const HOST_PORT = 8730;
const TEAMMATES = [
  { name: "alice", localApiPort: 8751 },
  { name: "bob", localApiPort: 8752 },
  { name: "carol", localApiPort: 8753 },
];

const session = {
  repoId: "github.com/acme/webapp",
  teamId: "team-playground",
  branch: "main",
  baseRevision: null,
};

const BOLD = "\u001b[1m";
const CYAN = "\u001b[36m";
const GREEN = "\u001b[32m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

async function main() {
  mkdirSync(PLAYGROUND_ROOT, { recursive: true });
  const admin = generateDeviceKey();

  console.log(`${BOLD}${CYAN}Starting CoordinationHost on wss://127.0.0.1:${HOST_PORT} …${RESET}`);
  const host = await startHost(
    {
      hostUrl: `wss://127.0.0.1:${HOST_PORT}`,
      tls: { devSelfSigned: true },
      dbPath: join(PLAYGROUND_ROOT, "host.db"),
      expiry: { heartbeatIntervalMs: 5000, lockExpiryIntervalMs: 15000 },
    },
    { expirySweepIntervalMs: 5000 },
  );
  host.authority.registerSession(session, [admin.publicKey]);
  const hostUrl = `wss://127.0.0.1:${host.port}`;

  const agents = [];
  for (const t of TEAMMATES) {
    const deviceKey = generateDeviceKey();
    const member = { memberId: t.name, deviceId: deriveDeviceId(deviceKey.publicKey) };
    const invitation = Buffer.from(
      JSON.stringify(
        issueInvitation(
          {
            session,
            devicePublicKey: deviceKey.publicKey,
            memberId: t.name,
            issuerPublicKey: admin.publicKey,
          },
          admin.privateKey,
        ),
      ),
      "utf8",
    ).toString("base64");

    const workspace = join(PLAYGROUND_ROOT, t.name);
    const token = generateLocalAuthToken();

    // Seed the workspace: a shared starter file + auto-connect settings.
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, ".vscode"), { recursive: true });
    writeFileSync(
      join(workspace, "src", "shared.ts"),
      `// Shared file — edit me in ${t.name}'s window and watch the other windows.\nexport const owner = "${t.name}";\n`,
    );
    writeFileSync(
      join(workspace, ".vscode", "settings.json"),
      JSON.stringify(
        {
          "cfls.localApi.url": `ws://127.0.0.1:${t.localApiPort}`,
          "cfls.localApi.token": token,
          "cfls.heartbeat.intervalMs": 5000,
        },
        null,
        2,
      ),
    );

    const agent = new CoordinationAgent({
      session,
      self: member,
      hostUrl,
      invitation,
      rules: ALL_SOFT_CONFIG,
      cacheDir: join(workspace, ".cfls-cache"),
      authorizedFolder: workspace,
      insecureTls: true,
      deviceKey,
      localApiPort: t.localApiPort,
      enableNamedPipe: false,
      localAuthToken: token,
      connection: { heartbeatIntervalMs: 5000, autoReconnect: true },
    });
    await agent.start();
    agents.push({ ...t, agent, workspace });
    console.log(`${GREEN}✓${RESET} agent ${BOLD}${t.name}${RESET} — Local_API ws://127.0.0.1:${t.localApiPort} — workspace ${DIM}${workspace}${RESET}`);
  }

  console.log(`\n${BOLD}${GREEN}Playground is running.${RESET}`);
  console.log(`${BOLD}Next:${RESET}`);
  console.log(`  1. In this repo, press ${BOLD}F5${RESET} and pick "Run CFLS Extension — alice" (opens alice's window).`);
  console.log(`  2. Press ${BOLD}F5${RESET} again and pick "…— bob" (and "…— carol") for more teammates.`);
  console.log(`  3. Edit ${BOLD}src/shared.ts${RESET} in one window; watch the CFLS status bar update in the others.`);
  console.log(`\n${DIM}Press Ctrl+C to stop the host and all agents.${RESET}\n`);

  const shutdown = async () => {
    console.log(`\n${DIM}Shutting down…${RESET}`);
    for (const a of agents) {
      try {
        await a.agent.stop();
      } catch {
        /* ignore */
      }
    }
    await host.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Stay alive.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Playground failed:", err);
  process.exit(1);
});
