/**
 * @cfls/protocol — the single source of truth for wire compatibility:
 * versioned message envelope, message catalog, DTOs, error codes, and JSON schemas
 * shared by host, agent, mcp-server, and extension.
 *
 * Task 2.1 lands the core DTOs and shared types (see ./models). The versioned
 * envelope catalog / error codes (2.2) and JSON-schema validation (2.3) follow.
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
