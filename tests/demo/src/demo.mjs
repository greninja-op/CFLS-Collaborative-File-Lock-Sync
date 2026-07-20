/**
 * Interactive single-laptop demo of the Collaborative File Lock Sync MVP.
 *
 * Boots ONE real CoordinationHost and THREE in-process CoordinationAgents —
 * "Alice", "Bob", and "Carol" — over the real local WSS transport (dev
 * self-signed TLS on an ephemeral 127.0.0.1 port). It then plays a scripted
 * scenario and, after each step, prints what each teammate's agent actually
 * sees in its machine-readable Risk_Map. Everything runs on one machine; the
 * "teammates" are just separate agent instances, exactly as separate laptops
 * would be, only pointed at 127.0.0.1.
 *
 * Run (after `pnpm -r build`):
 *   pnpm --filter @cfls/demo demo
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoordinationAgent } from "@cfls/agent";
import { ALL_SOFT_CONFIG } from "@cfls/core-state";
import { startHost } from "@cfls/host";
import {
  deriveDeviceId,
  generateDeviceKey,
  issueInvitation,
} from "@cfls/security";

// ---------------------------------------------------------------------------
// Tiny console helpers (no dependencies)
// ---------------------------------------------------------------------------

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[36m";
const YELLOW = "\u001b[33m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const RESET = "\u001b[0m";

const delay = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

function banner(title) {
  console.log(`\n${BOLD}${CYAN}${"=".repeat(72)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}${"=".repeat(72)}${RESET}`);
}

function step(text) {
  console.log(`\n${BOLD}${YELLOW}▶ ${text}${RESET}`);
}

function note(text) {
  console.log(`${DIM}  ${text}${RESET}`);
}

/** The Repository_Session all three teammates share. */
const session = {
  repoId: "github.com/acme/webapp",
  teamId: "team-demo",
  branch: "main",
  baseRevision: null,
};

/**
 * A shared, metadata-only dependency graph so the demo can show INDIRECT risk:
 * `src/api/login.ts` has a runtime import of `src/auth/session.ts`.
 */
const graph = {
  snapshot: {
    sessionId: session,
    graphVersion: 1,
    analyzerVersion: "demo-1",
  },
  packages: [],
  modules: [
    {
      sourceFile: "src/api/login.ts",
      edges: [
        {
          from: "src/api/login.ts",
          to: "src/auth/session.ts",
          kind: "runtime_import",
          confidence: "high",
        },
      ],
    },
  ],
  contracts: [],
};

/** Poll until `predicate()` is true or the timeout elapses. */
async function waitUntil(predicate, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

/** Pretty-print one teammate's current Risk_Map as the agent sees it. */
function printRiskMap(teammate) {
  const result = teammate.agent.agentPort().getRiskMap({ session });
  if (!result.ok) {
    console.log(
      `  ${RED}${teammate.name}: ${result.error.code} ${result.error.message}${RESET}`,
    );
    return;
  }
  const { paths, plannedFileCreations } = result.data;
  const conn = teammate.agent.agentPort().getConnection();
  const stale = teammate.agent.agentPort().getStaleness().stale;
  const online =
    conn.status === "online"
      ? `${GREEN}online${RESET}`
      : `${RED}offline${RESET}`;
  const staleTag = stale ? ` ${RED}(stale)${RESET}` : "";
  console.log(`  ${BOLD}${teammate.name}${RESET} [${online}${staleTag}] sees:`);

  if (paths.length === 0 && plannedFileCreations.length === 0) {
    console.log(`    ${DIM}(nothing — no risks on any file)${RESET}`);
    return;
  }
  for (const p of paths) {
    const color =
      p.riskLevel === "hard"
        ? RED
        : p.riskLevel === "coordination-required"
          ? YELLOW
          : DIM;
    const who = p.contributors
      .map((c) => `${c.memberId} (${c.kind})`)
      .join(", ");
    const kind = p.explanation.type === "indirect" ? " [indirect]" : "";
    console.log(
      `    • ${color}${p.path}${RESET} — ${BOLD}${p.riskLevel}${RESET}${kind} — ${who}`,
    );
  }
  for (const pfc of plannedFileCreations) {
    console.log(
      `    • ${DIM}${pfc.path}${RESET} — ${BOLD}planned new file${RESET} — ${pfc.memberId}`,
    );
  }
}

function printAll(teammates) {
  for (const t of teammates) printRiskMap(t);
}

async function main() {
  banner("Collaborative File Lock Sync — single-laptop demo");
  note(
    "One host + three teammates (Alice, Bob, Carol), all on 127.0.0.1 over real WSS.",
  );
  note(
    "Each 'teammate' is a separate CoordinationAgent — exactly like separate laptops.",
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), "cfls-demo-"));
  const admin = generateDeviceKey();

  step("Starting the CoordinationHost (dev self-signed TLS, ephemeral port)…");
  const host = await startHost(
    {
      hostUrl: "wss://127.0.0.1:0",
      tls: { devSelfSigned: true },
      dbPath: join(tmpRoot, "host.db"),
      // Fast heartbeat/expiry so the demo is snappy.
      expiry: { heartbeatIntervalMs: 1000, lockExpiryIntervalMs: 3000 },
    },
    { expirySweepIntervalMs: 0 },
  );
  host.authority.registerSession(session, [admin.publicKey]);
  const hostUrl = `wss://127.0.0.1:${host.port}`;
  note(`Host listening at ${hostUrl}`);

  // --- connect a teammate --------------------------------------------------
  async function connect(name) {
    const deviceKey = generateDeviceKey();
    const member = {
      memberId: name,
      deviceId: deriveDeviceId(deviceKey.publicKey),
    };
    const invitation = Buffer.from(
      JSON.stringify(
        issueInvitation(
          {
            session,
            devicePublicKey: deviceKey.publicKey,
            memberId: name,
            issuerPublicKey: admin.publicKey,
          },
          admin.privateKey,
        ),
      ),
      "utf8",
    ).toString("base64");

    const agent = new CoordinationAgent({
      session,
      self: member,
      hostUrl,
      invitation,
      rules: ALL_SOFT_CONFIG,
      cacheDir: join(tmpRoot, `cache-${name}`),
      insecureTls: true,
      deviceKey,
      localApiPort: 0,
      enableNamedPipe: false,
      graph,
      connection: { heartbeatIntervalMs: 0, autoReconnect: false },
    });
    await agent.start();
    return { name, agent, member };
  }

  step("Connecting three teammates…");
  const alice = await connect("Alice");
  const bob = await connect("Bob");
  const carol = await connect("Carol");
  const team = [alice, bob, carol];
  note(
    "Alice, Bob, and Carol are online and share the same repository session.",
  );

  // 1) Presence -------------------------------------------------------------
  banner("1. Presence — 'who is editing what'");
  step("Alice opens and starts editing  src/api/login.ts");
  alice.agent
    .hostConnection()
    .send("presence.report", { path: "src/api/login.ts", state: "editing" });
  await waitUntil(
    () =>
      bob.agent.view
        .entries(session)
        .some((e) => e.path === "src/api/login.ts"),
    "Bob to see Alice's edit",
  );
  note("Bob and Carol are notified in real time:");
  printAll(team);

  // 2) Direct conflict via a soft lock -------------------------------------
  banner("2. Direct conflict — Bob tries the SAME file Alice locked");
  step("Alice acquires a lock on  src/api/login.ts");
  await alice.agent
    .agentPort()
    .acquireLock({ session, scope: "src/api/login.ts", scopeKind: "file" });
  await delay(150);
  step("Bob's agent tries to acquire the same file…");
  const bobLock = await bob.agent.agentPort().acquireLock({
    session,
    scope: "src/api/login.ts",
    scopeKind: "file",
  });
  if (bobLock.ok && bobLock.data.granted === false) {
    console.log(
      `  ${RED}Bob is told the file is already held${RESET} by ${BOLD}${bobLock.data.winner?.memberId}${RESET} ` +
        `(winning revision ${bobLock.data.winner?.eventRevision}). Bob's agent backs off.`,
    );
  } else {
    console.log(
      `  ${DIM}(Bob's lock outcome: ${JSON.stringify(bobLock.ok ? bobLock.data : bobLock.error)})${RESET}`,
    );
  }

  // 3) Declared intent + planned new file ----------------------------------
  banner("3. Declared intent — Carol announces future work before editing");
  step(
    "Carol declares: will modify src/auth/session.ts and CREATE src/api/logout.ts",
  );
  await carol.agent.agentPort().declareIntent({
    session,
    modifyPaths: ["src/auth/session.ts"],
    createPaths: ["src/api/logout.ts"],
    description: "Add logout flow",
  });
  await waitUntil(
    () =>
      alice.agent.view
        .entries(session)
        .some((e) => e.member.memberId === "Carol"),
    "Alice to see Carol's declared intent",
  );
  note("Everyone's agent now knows Carol's plan BEFORE she writes any code:");
  printAll(team);

  // 4) Indirect dependency risk --------------------------------------------
  banner("4. Indirect dependency risk — different files, hidden link");
  note(
    "src/api/login.ts imports src/auth/session.ts (from the dependency graph).",
  );
  step("Carol starts editing  src/auth/session.ts  (Alice is on login.ts)…");
  carol.agent
    .hostConnection()
    .send("presence.report", { path: "src/auth/session.ts", state: "editing" });
  await delay(400);
  note(
    "Alice's agent can now flag that her file is indirectly affected by Carol's change:",
  );
  printRiskMap(alice);

  // 5) Release --------------------------------------------------------------
  banner("5. Release — the file frees up");
  step("Alice finishes and releases  src/api/login.ts");
  await alice.agent
    .agentPort()
    .releaseLock({ session, scope: "src/api/login.ts" });
  await delay(300);
  note("Bob's agent sees the lock is gone and the path is safer again:");
  printRiskMap(bob);

  // --- teardown ------------------------------------------------------------
  banner("Demo complete");
  note(
    "This is the real host + real agents over real WSS — the same code teammates run,",
  );
  note("just three instances on one laptop instead of three laptops.");

  for (const t of team) await t.agent.stop();
  await host.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
  // Give sockets a tick to close, then exit cleanly.
  await delay(100);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}Demo failed:${RESET}`, err);
  process.exit(1);
});
