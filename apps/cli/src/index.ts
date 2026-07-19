/**
 * @cfls/cli — the `cfls` multi-laptop onboarding tool.
 *
 * Turns the single-laptop demo into a real onboarding flow: a team admin issues
 * signed invitations and runs the CoordinationHost; each teammate registers a
 * device key, receives an invitation, and runs a CoordinationAgent that writes a
 * Local_API discovery file the VS Code extension auto-detects. The tool ONLY
 * moves coordination metadata + public keys around; the repository files
 * themselves are shared through git. It reuses `@cfls/security`, `@cfls/host`,
 * `@cfls/agent`, and `@cfls/core-state` — no host/agent/security logic is
 * reimplemented here.
 *
 * Commands: admin-init · host · id · invite · join · connect · agent.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CoordinationAgent, generateLocalAuthToken, loadRulesConfig } from "@cfls/agent";
import { startHost } from "@cfls/host";
import { deriveDeviceId, issueInvitation } from "@cfls/security";

import {
  appendAdminPublicKey,
  readAgentConfig,
  readHostConfig,
  updateAgentConfig,
  writeLocalApiConfig,
} from "./config-files";
import {
  agentConfigPath,
  hostConfigPath,
  localApiConfigPath,
} from "./paths";
import { decodeInvitation, encodeInvitation } from "./invitation";
import { createAdminKey, loadAdminKey, loadOrCreateThisDeviceKey } from "./keys";
import {
  boolOption,
  log,
  parseArgs,
  resolveRepoRoot,
  stringOption,
  waitForShutdown,
  type ParsedArgs,
} from "./runtime";
import {
  DEFAULT_TEAM_ID,
  describeSession,
  resolveRepositorySession,
} from "./session";

/** Default loopback Local_API port for `cfls agent` (matches the extension default). */
const DEFAULT_LOCAL_API_PORT = 8750;

/** Default Host_URL for `cfls host`. */
const DEFAULT_HOST_URL = "wss://0.0.0.0:8730";

/** `cfls admin-init` — create + store the team admin key, register it in host.json. */
async function cmdAdminInit(args: ParsedArgs): Promise<void> {
  const teamId = stringOption(args, "team") ?? readHostConfig(hostConfigPath())?.teamId ?? DEFAULT_TEAM_ID;
  const adminKey = await createAdminKey(teamId);
  const config = appendAdminPublicKey(hostConfigPath(), adminKey.publicKey, teamId);

  log.info(`Admin key created for team "${teamId}".`);
  log.info(`Admin private key stored securely (never written to disk in plaintext).`);
  log.info(`Host config: ${hostConfigPath()}`);
  log.info("");
  log.info("Admin Device_Public_Key (share/keep for reference):");
  log.info(adminKey.publicKey);
  log.info("");
  log.info(`Authorized admin keys for this host: ${config.authorizedAdminPublicKeys.length}`);
}

/** `cfls host` — start the CoordinationHost for this repo's session. */
async function cmdHost(args: ParsedArgs, cwd: string): Promise<void> {
  const hostConfig = readHostConfig(hostConfigPath());
  if (hostConfig === null || hostConfig.authorizedAdminPublicKeys.length === 0) {
    throw new Error(
      `No admin keys found in ${hostConfigPath()}. Run "cfls admin-init" first.`,
    );
  }

  const repoRoot = resolveRepoRoot(cwd);
  const repoOverride = stringOption(args, "repo");
  const { session } = resolveRepositorySession({
    repoRoot,
    teamId: hostConfig.teamId,
    ...(repoOverride !== undefined ? { remoteUrlOverride: repoOverride } : {}),
  });

  const hostUrl = stringOption(args, "url") ?? DEFAULT_HOST_URL;
  const certPath = stringOption(args, "cert") ?? process.env["CFLS_TLS_CERT"];
  const keyPath = stringOption(args, "key") ?? process.env["CFLS_TLS_KEY"];

  const tls =
    certPath !== undefined && keyPath !== undefined
      ? { certPath, keyPath }
      : { devSelfSigned: true };
  if (tls.devSelfSigned === true) {
    log.warn(
      "Starting with a development self-signed TLS certificate. Agents must pass " +
        "--insecure-tls. Provide --cert/--key (or CFLS_TLS_CERT/CFLS_TLS_KEY) for production.",
    );
  }

  const dbPath = stringOption(args, "db") ?? process.env["CFLS_DB_PATH"] ?? "host.db";
  const running = await startHost(
    { hostUrl, tls, dbPath },
    { expirySweepIntervalMs: 15_000 },
  );
  running.authority.registerSession(session, hostConfig.authorizedAdminPublicKeys);

  const shown = hostUrl.replace("0.0.0.0", "<this-machine-ip>");
  log.info(`CoordinationHost listening on ${shown} (bound port ${running.port}).`);
  log.info(`Serving session: ${describeSession(session)}`);
  log.info(`Authorized admin keys: ${hostConfig.authorizedAdminPublicKeys.length}`);
  log.info("Press Ctrl+C to stop.");

  await waitForShutdown(() => running.stop());
}

/** `cfls id` — ensure this device has a key; print its public key + deviceId. */
async function cmdId(cwd: string): Promise<void> {
  const repoRoot = resolveRepoRoot(cwd);
  const teamId = readAgentConfig(agentConfigPath(repoRoot)).teamId ?? DEFAULT_TEAM_ID;
  const { session } = resolveRepositorySession({ repoRoot, teamId });
  const deviceKey = await loadOrCreateThisDeviceKey(session.repoId);
  const deviceId = deriveDeviceId(deviceKey.publicKey);

  log.info("This device's identity:");
  log.info("");
  log.info("Device_Public_Key (send this to your team admin):");
  log.info(deviceKey.publicKey);
  log.info("");
  log.info(`deviceId: ${deviceId}`);
  log.info(`repo:     ${session.repoId}`);
}

/** `cfls invite <memberName> <devicePublicKeyBase64>` — sign an invitation. */
async function cmdInvite(args: ParsedArgs, cwd: string): Promise<void> {
  const [memberName, devicePublicKey] = args.positionals;
  if (memberName === undefined || devicePublicKey === undefined) {
    throw new Error("Usage: cfls invite <memberName> <devicePublicKeyBase64>");
  }

  const hostConfig = readHostConfig(hostConfigPath());
  if (hostConfig === null) {
    throw new Error(`No ${hostConfigPath()} found. Run "cfls admin-init" first.`);
  }

  const repoRoot = resolveRepoRoot(cwd);
  const repoOverride = stringOption(args, "repo");
  const { session } = resolveRepositorySession({
    repoRoot,
    teamId: hostConfig.teamId,
    ...(repoOverride !== undefined ? { remoteUrlOverride: repoOverride } : {}),
  });

  const adminKey = await loadAdminKey(hostConfig.teamId);
  const invitation = issueInvitation(
    {
      session,
      devicePublicKey,
      memberId: memberName,
      issuerPublicKey: adminKey.publicKey,
    },
    adminKey.privateKey,
  );

  log.info(`Invitation for "${memberName}" (session: ${describeSession(session)}):`);
  log.info("");
  log.info(encodeInvitation(invitation));
  log.info("");
  log.info(`The teammate runs:  cfls connect <the string above>`);
}

/** `cfls join --host <wss-url> [--name <memberName>]` — save join state. */
async function cmdJoin(args: ParsedArgs, cwd: string): Promise<void> {
  const hostUrl = stringOption(args, "host");
  if (hostUrl === undefined) {
    throw new Error("Usage: cfls join --host <wss-url> [--name <memberName>] [--team <id>]");
  }
  const repoRoot = resolveRepoRoot(cwd);
  const memberName = stringOption(args, "name");
  const teamId = stringOption(args, "team");

  updateAgentConfig(agentConfigPath(repoRoot), {
    hostUrl,
    ...(memberName !== undefined ? { memberName } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
  });

  const { session } = resolveRepositorySession({
    repoRoot,
    ...(teamId !== undefined ? { teamId } : {}),
  });
  const deviceKey = await loadOrCreateThisDeviceKey(session.repoId);

  log.info(`Saved join state to ${agentConfigPath(repoRoot)}.`);
  log.info(`Host_URL: ${hostUrl}`);
  log.info("");
  log.info("This device's Device_Public_Key (send it to your team admin):");
  log.info(deviceKey.publicKey);
  log.info("");
  log.info("Next steps:");
  log.info("  1. Send the public key above to your team admin.");
  log.info('  2. The admin runs:  cfls invite <yourName> <thePublicKey>');
  log.info("  3. Paste the invitation they return into:  cfls connect <invitation>");
  log.info("  4. Then start coordinating:  cfls agent --insecure-tls");
}

/** `cfls connect <invitationBase64>` — validate + store the invitation. */
function cmdConnect(args: ParsedArgs, cwd: string): void {
  const [encoded] = args.positionals;
  if (encoded === undefined) {
    throw new Error("Usage: cfls connect <invitationBase64>");
  }
  const invitation = decodeInvitation(encoded);
  const repoRoot = resolveRepoRoot(cwd);
  updateAgentConfig(agentConfigPath(repoRoot), {
    invitation: encoded,
    memberName: invitation.claims.memberId,
    teamId: invitation.claims.session.teamId,
  });

  log.info(`Invitation accepted and saved to ${agentConfigPath(repoRoot)}.`);
  log.info(`Member: ${invitation.claims.memberId}`);
  log.info(`Session: ${describeSession(invitation.claims.session)}`);
  log.info("");
  log.info("Start coordinating with:  cfls agent --insecure-tls");
}

/** `cfls agent [--insecure-tls] [--local-port 8750]` — run the CoordinationAgent. */
async function cmdAgent(args: ParsedArgs, cwd: string): Promise<void> {
  const repoRoot = resolveRepoRoot(cwd);
  const config = readAgentConfig(agentConfigPath(repoRoot));
  if (config.hostUrl === undefined) {
    throw new Error('No Host_URL saved. Run "cfls join --host <wss-url>" first.');
  }
  if (config.invitation === undefined) {
    throw new Error('No invitation saved. Run "cfls connect <invitation>" first.');
  }

  // The invitation carries the authoritative session the host will accept, so we
  // coordinate against it (git-derived branch/base drift can otherwise change the
  // session identity). The repoId is identical either way (same git remote).
  const invitation = decodeInvitation(config.invitation);
  const session = invitation.claims.session;

  const deviceKey = await loadOrCreateThisDeviceKey(session.repoId);
  if (deviceKey.publicKey !== invitation.claims.devicePublicKey) {
    throw new Error(
      "This device's key does not match the invitation. The admin must issue an " +
        "invitation for the public key shown by \"cfls id\" on THIS machine.",
    );
  }

  const memberId = config.memberName ?? invitation.claims.memberId;
  const self = { memberId, deviceId: deriveDeviceId(deviceKey.publicKey) };
  const rules = loadRulesConfig(repoRoot).config;

  const localApiPort = Number.parseInt(stringOption(args, "local-port") ?? "", 10);
  const port = Number.isInteger(localApiPort) && localApiPort > 0 ? localApiPort : DEFAULT_LOCAL_API_PORT;
  const localAuthToken = generateLocalAuthToken();

  // Publish the Local_API address + token so the VS Code extension auto-connects
  // with zero manual settings (Req 3.1). This file holds a per-session loopback
  // token only — no long-lived secret — and is gitignored.
  writeLocalApiConfig(localApiConfigPath(repoRoot), {
    url: `ws://127.0.0.1:${port}`,
    token: localAuthToken,
  });

  const agent = new CoordinationAgent({
    session,
    self,
    hostUrl: config.hostUrl,
    invitation: config.invitation,
    rules,
    cacheDir: `${repoRoot}/.coordination/.cache`,
    authorizedFolder: repoRoot,
    insecureTls: boolOption(args, "insecure-tls"),
    deviceKey,
    localApiPort: port,
    localAuthToken,
    enableNamedPipe: false,
    connection: { autoReconnect: true },
  });
  await agent.start();

  log.info(`CoordinationAgent started for "${memberId}".`);
  log.info(`Host_URL:  ${config.hostUrl}`);
  log.info(`Local_API: ws://127.0.0.1:${port} (extension auto-discovers via ${localApiConfigPath(repoRoot)})`);
  log.info(`Session:   ${describeSession(session)}`);
  log.info("Open this repo in VS Code (with the CFLS extension installed) — it goes Online automatically.");
  log.info("Press Ctrl+C to stop.");

  await waitForShutdown(() => agent.stop());
}

/** Print top-level usage. */
function printUsage(): void {
  log.info(
    [
      "cfls — Collaborative File Lock Sync onboarding tool",
      "",
      "Admin commands:",
      "  cfls admin-init [--team <id>]                 Create + store the team admin key",
      "  cfls host [--url wss://0.0.0.0:8730] [--db <path>]",
      "            [--cert <pem>] [--key <pem>] [--repo <url>]",
      "                                                Start the CoordinationHost",
      "  cfls invite <memberName> <devicePublicKey>    Issue a signed invitation",
      "",
      "Teammate commands:",
      "  cfls id                                       Show this device's public key + id",
      "  cfls join --host <wss-url> [--name <name>] [--team <id>]",
      "                                                Save host + name, print next steps",
      "  cfls connect <invitationBase64>               Store an invitation",
      "  cfls agent [--insecure-tls] [--local-port 8750]",
      "                                                Run the local CoordinationAgent",
    ].join("\n"),
  );
}

/** CLI entrypoint. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const cwd = process.cwd();

  try {
    switch (command) {
      case "admin-init":
        await cmdAdminInit(args);
        return 0;
      case "host":
        await cmdHost(args, cwd);
        return 0;
      case "id":
        await cmdId(cwd);
        return 0;
      case "invite":
        await cmdInvite(args, cwd);
        return 0;
      case "join":
        await cmdJoin(args, cwd);
        return 0;
      case "connect":
        cmdConnect(args, cwd);
        return 0;
      case "agent":
        await cmdAgent(args, cwd);
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printUsage();
        return 0;
      default:
        log.error(`Unknown command "${command}".`);
        printUsage();
        return 1;
    }
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Only run when executed directly (not when imported by tests). Compare the
// resolved filesystem paths (handling Windows separators and URL-encoded spaces).
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error: unknown) => {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
