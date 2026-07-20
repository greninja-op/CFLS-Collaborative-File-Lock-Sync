/**
 * @cfls/vscode-extension - the VS Code Editor_Extension entrypoint.
 *
 * The entrypoint owns the extension lifecycle and coordination refresh loop.
 * Every VS Code API call lives in `vscode-adapter`; pure presentation rules live
 * in `presence-ui`, so this module can remain a small orchestration boundary.
 */

import { ALL_SOFT_CONFIG, type RepositoryRulesConfig } from "@cfls/core-state";
import type {
  ConnectionSnapshot,
  GetRiskMapData,
  McpEnvelope,
  StalenessSnapshot,
} from "@cfls/mcp-server";
import type { SessionId } from "@cfls/protocol";

import { EditorEventForwarder } from "./editor-host";
import { enforceHardStop } from "./hard-stop";
import { LocalApiClient } from "./local-api-client";
import { buildCoordinationStatusDetail } from "./presence-ui";
import { WebSocketFrameTransport } from "./transport";
import {
  CoordinationUiController,
  onWillSaveTextDocument,
  readLocalApiSettings,
  registerCommand,
  showErrorMessage,
  showInformationMessage,
  showWarningMessage,
  type VsCodeExtensionContext,
  VsCodeEditorHost,
} from "./vscode-adapter";
import { buildCoordinationViewModel, type CoordinationViewModel } from "./view-model";

/** Package identifier. */
export const APP_NAME = "@cfls/vscode-extension";

/** Extension-scoped runtime state, torn down on deactivate. */
interface Runtime {
  client: LocalApiClient;
  editorHost: VsCodeEditorHost;
  forwarder: EditorEventForwarder;
  ui: CoordinationUiController;
  refreshTimer: ReturnType<typeof setInterval>;
}

let runtime: Runtime | undefined;
let currentViewModel: CoordinationViewModel | undefined;
let currentSession: SessionId | undefined;
let rules: RepositoryRulesConfig = ALL_SOFT_CONFIG;
const selfMemberId = "self";

/** Fetch the latest Risk_Map + connection snapshots and update every UI cue. */
async function refresh(client: LocalApiClient, ui: CoordinationUiController): Promise<void> {
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
  ui.render(currentViewModel);
}

/** Resolve the Repository_Session from the local CoordinationAgent. */
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

/** VS Code entrypoint. All runtime VS Code calls are delegated to the adapter. */
export async function activate(context: VsCodeExtensionContext): Promise<void> {
  const settings = readLocalApiSettings();
  const transport = new WebSocketFrameTransport(settings.url);
  const client = new LocalApiClient({
    transport,
    token: settings.token,
    heartbeatIntervalMs: settings.heartbeatIntervalMs,
  });

  const editorHost = new VsCodeEditorHost();
  const forwarder = new EditorEventForwarder(editorHost, (event) => client.sendEditorEvent(event));
  const ui = new CoordinationUiController({ selfMemberId });
  ui.register(context.subscriptions);

  // Seed an offline model so the status chip and all empty UI states are ready
  // before the first successful local-Agent request.
  currentViewModel = buildCoordinationViewModel({
    riskMap: { paths: [], plannedFileCreations: [], highestRevision: 0 },
    ...offlineSnapshot(),
  });
  ui.render(currentViewModel);

  try {
    await client.authenticate();
    await resolveSession(client);
    if (currentSession !== undefined) {
      await client.subscribe({ session: currentSession }, () => {
        void refresh(client, ui);
      });
    }
    await refresh(client, ui);
  } catch {
    // Remain in the offline view until connectivity is restored.
  }

  const refreshTimer = setInterval(() => {
    void refresh(client, ui);
  }, 2_000);
  refreshTimer.unref?.();

  // Cooperative hard-stop: reject a save to a hard-locked path held by another
  // member. It remains a clear error message, never an OS-level file lock.
  context.subscriptions.push(
    onWillSaveTextDocument((path) => {
      if (currentViewModel === undefined) {
        return;
      }
      const decision = enforceHardStop(currentViewModel, rules, path, selfMemberId);
      if (!decision.allowed) {
        showErrorMessage(decision.message);
      } else if (decision.reason === "offline-manual-coordination") {
        showWarningMessage(`${decision.message} (${path})`);
      }
    }),
    registerCommand("cfls.showCoordinationStatus", () => {
      const vm = currentViewModel;
      if (vm === undefined || vm.offline) {
        showWarningMessage(
          "CFLS: Offline - the local coordination agent is not reachable. Is the host running?",
        );
        return;
      }
      if (vm.paths.length === 0 && vm.plannedFileCreations.length === 0) {
        showInformationMessage("CFLS: Online. No teammates are currently editing tracked files.");
        return;
      }
      showInformationMessage(`CFLS coordination (${vm.paths.length} path(s)):`, {
        modal: true,
        detail: buildCoordinationStatusDetail(vm, selfMemberId),
      });
    }),
    registerCommand("cfls.reconnectLocalAgent", () => {
      void refresh(client, ui);
    }),
  );

  runtime = { client, editorHost, forwarder, ui, refreshTimer };
}

/** VS Code teardown. */
export function deactivate(): void {
  if (runtime === undefined) {
    return;
  }
  clearInterval(runtime.refreshTimer);
  runtime.forwarder.dispose();
  runtime.editorHost.dispose();
  runtime.ui.dispose();
  runtime.client.close();
  runtime = undefined;
}
