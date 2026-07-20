/**
 * @cfls/agent — the per-user CoordinationAgent: one outbound WSS connection,
 * loopback-only Local_API, embedded Local_MCP_Server, Authorized_Folder watcher,
 * local encrypted cache, reconnect/re-assert, and Windows packaging
 * (design §3.2; Req 2, 5, 6, 9, 15, 31, 33, 34, 35). Implemented in tasks 9.1–9.9.
 */

export const APP_NAME = "@cfls/agent";

// ---- Exponential backoff (task 9.1) ----
export {
  ExponentialBackoff,
  backoffSchedule,
  backoffDelayForAttempt,
  resolveBackoffConfig,
  type BackoffOptions,
  type ResolvedBackoffConfig,
} from "./backoff";

// ---- WSS client connection + Offline_State (task 9.1) ----
export {
  HostConnection,
  type HostConnectionOptions,
  type ConnectionState,
  type SendResult,
  type SyncResponse,
} from "./connection";

// ---- Local_API (task 9.2) ----
export {
  LocalApiServer,
  generateLocalAuthToken,
  tokensMatch,
  isLoopbackAddress,
  type LocalApiServerOptions,
  type LocalApiAddress,
  type LocalApiHandlers,
  type LocalAuthToken,
} from "./local-api";

// ---- Local_API request dispatch (task 9.2, 9.3) ----
export {
  dispatchLocalRequest,
  LOCAL_API_METHODS,
  type LocalApiMethod,
} from "./dispatch";

// ---- Shared cached view + real AgentPort + host gateway (task 9.3) ----
export { AgentView, type PlannedCreation } from "./view";
export { AgentCoordinationPort, type AgentPortOptions } from "./port";
export {
  RealHostGateway,
  LocalHostGateway,
  type HostGateway,
  type MutationEvent,
  type TransmitResult,
  type LocalHostGatewayOptions,
} from "./gateway";

// ---- Authorized_Folder watcher (task 9.4) ----
export {
  FolderWatcher,
  reconcileFileChange,
  DEFAULT_IGNORED_DIRS,
  type FolderWatcherOptions,
  type FileChangeEvent,
  type FileChangeKind,
  type ReconciledMessage,
} from "./watcher";

// ---- Local encrypted cache (task 9.5) ----
export { EncryptedCache, type EncryptedCacheOptions } from "./cache";

// ---- Device_Key storage + config/rules loading (task 9.6) ----
export { loadOrCreateDeviceKey } from "./keystore";
export {
  resolveSession,
  loadRulesConfig,
  type ResolveSessionInput,
  type ResolvedSession,
  type ManualSessionConfig,
  type LoadedRules,
} from "./config";

// ---- Windows login-startup registration (task 9.7) ----
export {
  registerLoginStartup,
  unregisterLoginStartup,
  buildRunKeyAddArgs,
  buildRunKeyDeleteArgs,
  startupFolderPath,
  HKCU_RUN_KEY,
  STARTUP_ENTRY_NAME,
  type RegisterStartupOptions,
  type StartupResult,
  type CommandRunner,
} from "./startup";

// ---- The assembled agent (tasks 9.1–9.6) ----
export {
  CoordinationAgent,
  type CoordinationAgentConfig,
  type RunningAgent,
} from "./agent";
