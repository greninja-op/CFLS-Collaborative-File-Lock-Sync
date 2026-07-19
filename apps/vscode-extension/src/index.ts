/**
 * @cfls/vscode-extension — the VS Code Editor_Extension entrypoint.
 *
 * It talks ONLY to the local CoordinationAgent through the Local_API (Req 3.1),
 * emits the eight editor events within 2s (Req 3.2), renders coordination state
 * and the offline/stale indicator (Req 3.3, 3.4, 3.6), enforces cooperative
 * hard-stop for hard-locked paths (Req 3.5, 14), and sends periodic heartbeats to
 * the agent (Req 26.6).
 *
 * All coordination logic lives in the pure modules (`local-api-client`,
 * `editor-host`, `view-model`, `hard-stop`); this file only wires them to the
 * `vscode` runtime via the thin adapter, so the test suite runs without VS Code.
 */

import * as vscode from "vscode";

import { ALL_SOFT_CONFIG, type RepositoryRulesConfig } from "@cfls/core-state";
import type {
  ConnectionSnapshot,
  GetRiskMapData,
  McpEnvelope,
  StalenessSnapshot,
} from "@cfls/mcp-server";
import type { SessionId } from "@cfls/protocol";

import { EditorEventForwarder } from "./editor-host";
import { LocalApiClient } from "./local-api-client";
import { WebSocketFrameTransport } from "./transport";
import {
  buildCoordinationViewModel,
  type CoordinationViewModel,
} from "./view-model";
import { enforceHardStop } from "./hard-stop";
import {
  readLocalApiSettings,
  StatusBarRenderer,
  toRepoRelativePath,
  VsCodeEditorHost,
} from "./vscode-adapter";

/** Package identifier. */
export const APP_NAME = "@cfls/vscode-extension";

/** Extension-scoped runtime state, torn down on deactivate. */
interface Runtime {
  client: LocalApiClient;
  editorHost: VsCodeEditorHost;
  forwarder: EditorEventForwarder;
  renderer: StatusBarRenderer;
  refreshTimer: ReturnType<typeof setInterval>;
}

let runtime: Runtime | undefined;
let currentViewModel: CoordinationViewModel | undefined;
let currentSession: SessionId | undefined;
let rules: RepositoryRulesConfig = ALL_SOFT_CONFIG;
const selfMemberId = "self";

/** Fetch the latest Risk_Map + connection snapshots and re-render (Req 3.3). */
async function refresh(client: LocalApiClient, renderer: StatusBarRenderer): Promise<void> {
  if (currentSession === undefined) {
    return;
  }
  const envelope = (await client.request("get_risk_map", {
    session: currentSession,
  })) as McpEnvelope<GetRiskMapData>;
  if (!envelope.ok || envelope.data === undefined) {
    return;
  }
  currentViewModel = buildCoordinationViewModel({
    riskMap: envelope.data,
    connection: envelope.connection,
    staleness: envelope.staleness,
  });
  renderer.render(currentViewModel);
}

/** Resolve the Repository_Session from the agent (Req 10). */
async function resolveSession(client: LocalApiClient): Promise<void> {
  const envelope = (await client.request("get_project_session_status", {})) as McpEnvelope<{
    session: {
      repoId: string;
      teamId: string;
      branch: string;
      baseRevision: string | null;
    };
  }>;
  if (envelope.ok && envelope.data !== undefined) {
    currentSession = { ...envelope.data.session };
  }
}

/** Blank offline snapshots used before the first successful fetch. */
function offlineSnapshot(): { connection: ConnectionSnapshot; staleness: StalenessSnapshot } {
  return {
    connection: { status: "offline", hostUrl: "", lastSyncAt: null },
    staleness: { stale: true, secondsSinceSync: null },
  };
}

/** VS Code entrypoint. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settings = readLocalApiSettings();
  const transport = new WebSocketFrameTransport(settings.url);
  const client = new LocalApiClient({
    transport,
    token: settings.token,
    heartbeatIntervalMs: settings.heartbeatIntervalMs,
  });

  const editorHost = new VsCodeEditorHost();
  const forwarder = new EditorEventForwarder(editorHost, (event) =>
    client.sendEditorEvent(event),
  );
  const renderer = new StatusBarRenderer();

  // Seed an offline view model so the indicator shows immediately (Req 3.6).
  currentViewModel = buildCoordinationViewModel({
    riskMap: { paths: [], plannedFileCreations: [], highestRevision: 0 },
    ...offlineSnapshot(),
  });
  renderer.render(currentViewModel);

  try {
    await client.authenticate();
    await resolveSession(client);
    if (currentSession !== undefined) {
      await client.subscribe({ session: currentSession }, () => {
        void refresh(client, renderer);
      });
    }
    await refresh(client, renderer);
  } catch {
    // Remain in the offline view until connectivity is restored.
  }

  const refreshTimer = setInterval(() => {
    void refresh(client, renderer);
  }, 2_000);
  refreshTimer.unref?.();

  // Cooperative hard-stop: reject saves to a hard-locked path held by another
  // member (Req 3.5, 14). Enforcement is cooperative, never OS-level (Req 14.2).
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (currentViewModel === undefined) {
        return;
      }
      const path = toRepoRelativePath(e.document.uri);
      const decision = enforceHardStop(currentViewModel, rules, path, selfMemberId);
      if (!decision.allowed) {
        void vscode.window.showErrorMessage(decision.message);
      } else if (decision.reason === "offline-manual-coordination") {
        void vscode.window.showWarningMessage(
          `${decision.message} (${path})`,
        );
      }
    }),
    vscode.commands.registerCommand("cfls.showCoordinationStatus", () => {
      void vscode.window.showInformationMessage(
        currentViewModel?.statusText ?? "CFLS: not connected",
      );
    }),
    vscode.commands.registerCommand("cfls.reconnectLocalAgent", () => {
      void refresh(client, renderer);
    }),
  );

  runtime = { client, editorHost, forwarder, renderer, refreshTimer };
}

/** VS Code teardown. */
export function deactivate(): void {
  if (runtime === undefined) {
    return;
  }
  clearInterval(runtime.refreshTimer);
  runtime.forwarder.dispose();
  runtime.editorHost.dispose();
  runtime.renderer.dispose();
  runtime.client.close();
  runtime = undefined;
}
