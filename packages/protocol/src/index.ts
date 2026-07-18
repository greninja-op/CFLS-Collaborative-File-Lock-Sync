/**
 * @cfls/protocol — the single source of truth for wire compatibility:
 * versioned message envelope, message catalog, DTOs, error codes, and JSON schemas
 * shared by host, agent, mcp-server, and extension.
 *
 * Task 2.1 lands the core DTOs and shared types (see ./models). Task 2.2 adds the
 * versioned envelope (./envelope), the message catalog (./messages), and the
 * error-code union (./errors). JSON-schema validation (2.3) follows.
 */

/** Package identifier. */
export const PACKAGE_NAME = "@cfls/protocol";

// ---- Core DTOs and shared types (design §5.1) ----
export type {
  RiskLevel,
  ScopeKind,
  EdgeKind,
  Confidence,
  SessionId,
  MemberRef,
  RepositorySession,
  EventEnvelope,
  SignedEvent,
  Lock,
  Presence,
  PlannedFileCreation,
  DeclaredIntent,
  RepositorySnapshotMetadata,
  PackageDependencyMetadata,
  DependencyEdge,
  ModuleDependencyMetadata,
  PublicContractFingerprint,
  ChangeDeltaMetadata,
  DependencyGraph,
  RiskMapEntry,
  AuditRecord,
  MembershipRegistryEntry,
  CoordinationUpdate,
} from "./models";

// ---- Error codes (design §11.1) ----
export type { ErrorCode, ProtocolError } from "./errors";
export { ERROR_CODES, isErrorCode } from "./errors";

// ---- Versioned envelope + canonical serialization (design §4.2) ----
export {
  MESSAGE_FORMAT_VERSION,
  buildEnvelope,
  toSignedEvent,
  canonicalize,
  canonicalEnvelopeString,
} from "./envelope";
export type {
  MessageFormatVersion,
  ReplayGuard,
  TypedEventEnvelope,
  BuildEnvelopeInput,
} from "./envelope";

// ---- Message catalog: type constants (design §4.3) ----
export {
  AuthMessageType,
  PresenceMessageType,
  LockMessageType,
  IntentMessageType,
  DependencyMessageType,
  PathMessageType,
  HeartbeatMessageType,
  SyncMessageType,
  BroadcastMessageType,
  ErrorMessageType,
  MessageType,
  MESSAGE_TYPES,
  isMessageType,
} from "./messages";

// ---- Message catalog: payload types (design §4.3, §4.7) ----
export type {
  MessageTypeName,
  MessagePayloadMap,
  AuthHelloPayload,
  AuthChallengePayload,
  AuthResponsePayload,
  AuthOkPayload,
  AuthErrorPayload,
  PresenceReportPayload,
  PresenceUpdatePayload,
  LockAcquirePayload,
  LockReleasePayload,
  LockOverridePayload,
  LockUpdatePayload,
  LockConflictPayload,
  IntentDeclarePayload,
  IntentUpdatePayload,
  IntentWithdrawPayload,
  IntentProgressPayload,
  IntentUpdateBroadcastPayload,
  IntentConflictPayload,
  DepSnapshotPayload,
  ChangedDependencyEdge,
  DepDeltaPayload,
  DepAppliedPayload,
  PathRenamedPayload,
  PathDeletedPayload,
  FileCreatedPayload,
  PathUpdatePayload,
  HeartbeatPingPayload,
  HeartbeatAckPayload,
  SyncRequestPayload,
  SyncEventsPayload,
  SessionStateSnapshot,
  SyncSnapshotPayload,
  CoordinationUpdatePayload,
  ErrorPayload,
} from "./messages";
