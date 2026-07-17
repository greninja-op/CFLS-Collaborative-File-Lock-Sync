# Requirements Document

## Introduction

The Collaborative File Lock Sync feature provides a real-time, machine-readable coordination layer whose **primary consumer is the AI_Agent / code editor**, not the human developer. Its core purpose is to tell each AI_Agent, in a form it can act on programmatically, (a) which files another Team_Member is currently changing (active Soft_Locks and Presence_Events), (b) which files another Team_Member will or might change (Declared_Intents plus Planned_File_Creations), and (c) which files are **indirectly at risk** because they depend on files being changed elsewhere (dependency-aware coordination) — together forming a Risk_Map — so that an AI_Agent can autonomously avoid those files or coordinate before it edits or creates any file. Multiple AI agents and developers editing shared files independently risk overwriting each other's work and introducing breakage through indirect dependencies; giving agents a current, queryable view of "what is being changed now", "what will or might be changed", and "what is affected by those changes" lets them prevent collisions before they occur.

The system uses a **host-based client/server architecture**. A single designated host machine runs the CoordinationHost, a server process that is the definitive coordination authority. Every teammate's computer runs a per-user CoordinationAgent that maintains one outbound, encrypted, persistent connection to the CoordinationHost, exposes a local-only API, and embeds a Local_MCP_Server. The Visual Studio Code extension communicates only with its local CoordinationAgent; it never talks to the CoordinationHost directly. AI agents interact with the system exclusively through the Local_MCP_Server, which is strictly local to the teammate's computer and is never used as the network protocol to the CoordinationHost.

The CoordinationHost authenticates devices and users, validates team membership and Repository_Session access, receives Signed_Events carrying **metadata only**, assigns a **monotonic Event_Revision** that is the authoritative ordering and conflict resolver (raw client timestamps are never the sole conflict resolver), maintains active locks, presence, intents, dependency metadata, subscriptions, and heartbeats, and broadcasts updates only to authorized participants in the same Repository_Session. The CoordinationHost is designed to run initially on the user's laptop and later move **unchanged** to a VPS or company server, reachable through a configurable secure Host_URL with no hardcoded network address.

Coordination applies at three Risk_Levels: **soft** (advisory warning that does not block editing), **coordination-required** (the user or AI_Agent must explicitly acknowledge or override, and the Override_Reason is recorded in the Audit_Record), and **hard** (cooperating IDE extensions and AI agents reject edits while another valid winning lock exists — enforced by participating tools, not the operating system). Hard and coordination-required paths are defined by a Repository_Rules_Config file that maps path globs to a Risk_Level mode.

Security is based on **per-device cryptographic identity** rather than a single shared team credential. Each device generates an Ed25519 Device_Key locally, stores the private key in the OS_Credential_Store where possible, is admitted to a Repository_Session through a Signed_Invitation issued by a team admin, and has its identity, membership, invitation validity, and revocation status validated by the CoordinationHost. All client-host traffic is encrypted with TLS, all coordination events are signed with device keys, and all untrusted network messages are validated. The system never transmits project source contents, secrets, or local filesystem paths outside the authorized repository.

This document describes the **full end-state vision**. The Scope and Phasing section below identifies which capabilities are delivered in the initial MVP and which are deferred; each requirement is annotated with a bracketed phase tag in its title.

## Scope and Phasing

This feature is delivered in phases. Each requirement is annotated with a bracketed phase tag in its title — "(Phase: MVP)" or "(Phase: Future)". For requirements whose acceptance criteria span both phases, the title uses "(Phase: MVP + Future)" and each affected criterion identifies its phase inline.

### MVP Scope

The initial MVP delivers the full coordination value on the host-based client/server model:

- **CoordinationHost** running on one designated host machine, reachable through a configurable secure Host_URL, acting as the definitive coordination authority, and structured so the same process can later move to a VPS or company server unchanged. Local development storage may be SQLite, structured to later move to PostgreSQL.
- **CoordinationAgent** installed per user on every teammate's computer, starting automatically at user login without requiring administrator privileges unless necessary, holding one outbound encrypted persistent connection to the CoordinationHost, and exposing a local-only API.
- **Visual Studio Code extension** as the single supported editor client, communicating only with the local CoordinationAgent.
- **Local_MCP_Server** embedded in the CoordinationAgent, strictly local, exposing the defined MCP tools to AI agents.
- **Per-device security**: Ed25519 Device_Keys, Signed_Invitation admission, device revocation and Key_Rotation, TLS transport, event signing, and message validation.
- **Three Risk_Levels**: soft, coordination-required (with Override_Reason auditing), and hard (enforced by cooperating tools), driven by a Repository_Rules_Config file.
- **Core coordination**: Presence_Events, Soft_Locks, Declared_Intents and Planned_File_Creations, Risk_Map queries and pushed updates, monotonic Event_Revisions, reconnect-safe synchronization.
- **Dependency-aware coordination**: metadata-only Dependency_Graph build, snapshot and incremental deltas, per-session/branch storage, direct and indirect/reverse-dependency conflict detection, and dependency impact reports.
- **Repository_Session model**: canonical repository ID, team ID, branch/worktree identifier, base revision, normalized repository-relative paths, cross-platform path normalization and case-sensitivity handling, and a manual session configuration fallback.
- **Resilience and safety**: heartbeats and stale lock/intent expiry, health and diagnostics endpoints, Audit_Records, data minimization, rename/move/delete handling, multiple local clients per user, offline degradation with staleness marking, and rate limiting and deduplication.

### Future Phases

The following capabilities are deferred beyond the MVP:

- **Direct peer-to-peer connections** between agents, replacing or supplementing the host-based path.
- **Network-address-translation (NAT) traversal** for agents on different networks.
- **Local-network (LAN) discovery** of agents on the same network.
- **Peer mesh** topology as an alternative to the central CoordinationHost.
- **Additional IDEs** beyond Visual Studio Code.
- **Additional operating-system platforms** beyond the first Windows target.
- **Service-based startup models** (Windows Service, macOS launchd, Linux systemd); the MVP uses a per-user login startup process first.
- **Migration from SQLite to PostgreSQL** for the CoordinationHost store.
- **Higher-level semantic lock scopes** such as component-level, migration-level, or API-contract-level locking. (Public-contract dependency *metadata* is in MVP scope for indirect risk detection, but semantic *lock* scopes remain future.)

### Out of Scope

- The system does not store, transmit, or synchronize project source contents; it is not a version-control system or a file-transfer path.
- The Local_MCP_Server is not used as the network transport between agents and the CoordinationHost.
- Enforcement of hard locks by the operating system; enforcement is performed only by cooperating participating tools.

## Glossary

- **CoordinationHost**: The single server process, running on one designated host machine, that is the definitive coordination authority. It authenticates devices and users, validates team membership and Repository_Session access, maintains persistent client connections, receives Signed_Events, validates message schemas and permissions, assigns monotonic Event_Revisions, maintains active locks, presence, intents, dependency metadata, subscriptions, and heartbeats, broadcasts updates only to authorized participants in the same Repository_Session, persists event and audit metadata, supports reconnect and synchronization from a known Event_Revision, expires stale locks and intents after missed heartbeats, and exposes health and diagnostics endpoints. The CoordinationHost never stores project source contents and never requires access to teammates' project folders.
- **Host_Machine**: The computer on which the CoordinationHost runs. In the MVP this may be a teammate's laptop; the CoordinationHost is designed to move unchanged to a VPS or always-on company server later.
- **Host_URL**: The configurable secure address at which the CoordinationHost is reachable. The Host_URL is configured rather than hardcoded, and never encodes a fixed IP address as the only means of reaching the CoordinationHost.
- **CoordinationAgent**: The per-user background process installed on each teammate's computer. It starts automatically at user login, maintains one outbound encrypted persistent connection to the CoordinationHost, exposes a local-only API to the Editor_Extension and AI agents, embeds the Local_MCP_Server, watches only the Authorized_Folder, builds the local Dependency_Graph and Risk_Map, caches encrypted coordination state locally, reconnects with exponential backoff, and marks data as stale when host connectivity is lost. The CoordinationAgent never uploads project file contents and never silently edits files.
- **Local_API**: The local-only interface exposed by the CoordinationAgent (for example a named pipe, Unix domain socket, or authenticated localhost-only connection) through which the Editor_Extension and AI agents communicate with the CoordinationAgent. The Local_API is reachable only from the same computer.
- **Editor_Extension**: The Visual Studio Code extension running on a teammate's computer. It communicates only with the local CoordinationAgent, detects editor activity, sends editor events to the CoordinationAgent, receives coordination updates from the CoordinationAgent, and displays presence, locks, intents, planned file creation, dependency impact, offline/stale state, and warnings.
- **Local_MCP_Server**: The Model Context Protocol interface embedded in or beside the CoordinationAgent, strictly local to the teammate's computer, through which AI agents query the Risk_Map and declare work. The Local_MCP_Server is never the network protocol between agents and the CoordinationHost.
- **AI_Agent**: An automated assistant or AI-assisted code editor that acts on behalf of a Team_Member through the Local_MCP_Server. The AI_Agent is the primary consumer of the system: it queries and subscribes to coordination data, declares planned work, and autonomously avoids or coordinates around at-risk files before editing or creating any file.
- **Team_Member**: An authorized developer who contributes to the shared repository and participates in a Repository_Session through a CoordinationAgent.
- **Team_Admin**: A Team_Member authorized to issue Signed_Invitations that grant a device access to a Repository_Session.
- **Device_Key**: The per-device Ed25519 asymmetric key pair, comprising a Device_Private_Key and a Device_Public_Key, generated locally on each device to uniquely identify and authenticate that device.
- **Device_Private_Key**: The secret half of a Device_Key, held only by the owning device and stored in the OS_Credential_Store where possible. Used to sign coordination events and to prove device identity.
- **Device_Public_Key**: The public half of a Device_Key, registered with the CoordinationHost so it can authenticate events and connections originating from the owning device.
- **OS_Credential_Store**: The operating-system-provided secure credential storage in which a device retains its Device_Private_Key and related secrets, protected from other users and processes on the computer.
- **Signed_Invitation**: A cryptographically signed admission credential issued by a Team_Admin's device that grants a device (identified by its Device_Public_Key) access to a Repository_Session. Admission requires a valid Signed_Invitation.
- **Membership_Registry**: The CoordinationHost-maintained record of the Device_Public_Keys authorized for a Repository_Session, their associated Team_Member identities, invitation validity, and revocation status.
- **Key_Rotation**: The process by which a device replaces its Device_Key with a new key pair and registers the new Device_Public_Key with the CoordinationHost, after which subsequent events are authenticated against the new key.
- **Device_Revocation**: The process of marking a device's Device_Public_Key as no longer authorized, after which the CoordinationHost rejects connections and events authenticated by that key.
- **Event_Revision**: The monotonically increasing ordinal that the CoordinationHost assigns to each accepted coordination event. The Event_Revision is the authoritative ordering and the definitive conflict resolver; raw client timestamps are never used as the sole conflict resolver.
- **Signed_Event**: A coordination message created by a CoordinationAgent, carrying metadata only, signed with the device's Device_Private_Key, and bearing a unique Event_ID, a message-format version, and replay-protection data.
- **Event_ID**: The globally unique identifier assigned to a Signed_Event by the originating CoordinationAgent, used for idempotency and replay protection.
- **Repository_Session**: The coordination context scoped to a single shared project, identified by a canonical repository ID, a team ID, a branch or worktree identifier, and a base revision or commit hash where available, using normalized repository-relative paths. Coordination events and Dependency_Graphs from unrelated repositories, different teams, or different branches/worktrees are not mixed unless explicitly configured.
- **Branch_Context**: The branch or worktree identifier component of a Repository_Session, recorded so activity on the same repository-relative path can be distinguished by branch or worktree.
- **Base_Revision**: The base revision or commit hash of a Repository_Session where repository metadata is available, used to scope Dependency_Graphs and detect divergence.
- **Authorized_Folder**: The single project folder that a Team_Member or Editor_Extension has explicitly authorized the CoordinationAgent to watch. The CoordinationAgent watches only the Authorized_Folder and never scans the whole computer.
- **Risk_Level**: The classification assigned to a repository-relative path or scope, taking one of three values: **soft** (advisory warning that does not block editing), **coordination-required** (an explicit acknowledgement or override with an Override_Reason is required), or **hard** (cooperating tools reject edits while another valid winning lock exists). The soft, coordination-required, or hard mode of a path is determined by the Repository_Rules_Config, defaulting to soft.
- **Repository_Rules_Config**: The repository configuration file that maps path glob patterns to a Risk_Level mode of hard, coordination-required, or soft, defining which paths are enforced beyond the default soft behavior.
- **Soft_Lock**: An advisory claim by one Team_Member over a repository-relative path or scope indicating active editing, which warns others but does not block their edits.
- **Coordination_Required_Lock**: A lock over a path whose Risk_Level mode is coordination-required, under which another Team_Member or AI_Agent must explicitly acknowledge or override before editing, recording an Override_Reason in the Audit_Record.
- **Hard_Lock**: A lock over a path whose Risk_Level mode is hard, under which cooperating Editor_Extensions and AI agents reject edits while another valid winning lock exists. Enforcement is performed by participating tools, not the operating system.
- **Override_Reason**: The reason a Team_Member or AI_Agent supplies when acknowledging or overriding a coordination-required or hard restriction, recorded in the Audit_Record.
- **Presence_Event**: A message reporting that a Team_Member has started editing, is currently editing, or has stopped editing a specific repository-relative path.
- **Editor_Event**: An event detected by the Editor_Extension reporting editor activity — workspace opened, file opened, active editor changed, editing started, file saved, file closed, file renamed, or file deleted — and sent to the local CoordinationAgent.
- **Declared_Intent**: A forward-looking statement, submitted by an AI_Agent on behalf of a Team_Member, describing planned work: a set of existing repository-relative paths to modify and a set of Planned_File_Creations, with a description. Also referred to as a Planned_Change_Set.
- **Planned_File_Creation**: An entry within a Declared_Intent identifying a repository-relative path (up to 4096 characters) that an AI_Agent intends to create as a new file that does not yet exist in the Repository_Session.
- **Intent_Scope**: The extent of a Declared_Intent or lock, expressed as a single repository-relative file path, a repository-relative folder path, or a glob pattern. Higher-level semantic scopes such as components, migrations, or API contracts are out of scope.
- **Dependency_Graph**: The metadata-only graph the CoordinationAgent builds locally from the Authorized_Folder, describing dependency relationships among source files and packages without ever containing source contents. Its metadata comprises the Repository_Snapshot_Metadata, Package_Dependency_Metadata, Module_Dependency_Metadata, Public_Contract_Fingerprint set, and Change_Delta_Metadata categories.
- **Repository_Snapshot_Metadata**: The Dependency_Graph metadata identifying the repository session ID, Branch_Context, Base_Revision, graph version, and analyzer version.
- **Package_Dependency_Metadata**: The Dependency_Graph metadata describing a package manifest: manifest path, package manager, direct dependency names, declared version ranges, dependency scope, and lockfile hash.
- **Module_Dependency_Metadata**: The Dependency_Graph metadata describing a Dependency_Edge between modules: normalized repository-relative source file path, the from and to endpoints of the edge, edge kind (runtime import, type-only import, test dependency, build dependency, generated dependency, or dynamic-unknown), and confidence (high, medium, low, or unknown).
- **Dependency_Edge**: A single directed relationship in the Module_Dependency_Metadata, from one repository-relative source file to another, with an edge kind and a confidence value.
- **Public_Contract_Fingerprint**: The Dependency_Graph metadata capturing a fingerprint or hash of a public contract — public API fingerprint, exported interface or schema fingerprint, database schema fingerprint, API/OpenAPI/GraphQL schema fingerprint, migration identifiers, or build/CI/config fingerprint — without the contract's contents.
- **Change_Delta_Metadata**: The incremental Dependency_Graph metadata describing what changed: changed Dependency_Edges, changed manifests, changed lockfile hash, changed Public_Contract_Fingerprints, and changed schema, migration, or config metadata.
- **Dependency_Impact_Report**: The report the CoordinationHost produces from Dependency_Graph metadata identifying, for a set of paths, the direct dependencies, reverse dependencies (dependents), and shared public contracts affected, together with the resulting Risk_Levels and explanation paths.
- **Risk_Map**: The AI_Agent-oriented projection of coordination data for a Repository_Session that identifies the repository-relative paths currently being changed (active Soft_Locks and Presence_Events), the paths and Planned_File_Creations that will or might be changed (active Declared_Intents), and the paths indirectly at risk through the Dependency_Graph, each with its Risk_Level and explanation, enabling an AI_Agent to decide programmatically which files to avoid or coordinate on.
- **Coordination_Subscription**: A standing registration by an AI_Agent through the Local_MCP_Server, or by the Editor_Extension through the Local_API, to receive pushed coordination updates for a Repository_Session so its Risk_Map stays current without polling.
- **Coordination_Update**: A pushed message reporting a change to the coordination data of a Repository_Session — an added or removed Soft_Lock, Presence_Event, Declared_Intent, Planned_File_Creation, or dependency risk — carrying the assigning Event_Revision.
- **Heartbeat**: A periodic liveness signal exchanged between a CoordinationAgent and the CoordinationHost, and between the Editor_Extension and its local CoordinationAgent, indicating that the connection and any held locks and intents remain active.
- **Lock_Expiry_Interval**: The configured duration after which the CoordinationHost releases a lock or intent automatically if no Heartbeat confirming its holder is received.
- **Audit_Record**: The persisted metadata record maintained by the CoordinationHost identifying which user and device created, updated, withdrew, or overrode a lock or intent, including any Override_Reason, without any project source contents.
- **Offline_State**: The explicit state a CoordinationAgent enters when the CoordinationHost is unreachable, in which cached coordination data is marked stale, hard-lock safety is not claimed, and manual coordination is indicated.

## Requirements

### Requirement 1: CoordinationHost Lifecycle and Authority (Phase: MVP)

**User Story:** As a team, I want a single host process that acts as the definitive coordination authority, so that all agents and editors share one consistent, ordered view of who is changing what.

#### Acceptance Criteria

1. WHEN the CoordinationHost starts, THE CoordinationHost SHALL begin listening for CoordinationAgent connections at the configured Host_URL within 10 seconds.
2. THE CoordinationHost SHALL act as the definitive coordination authority for every Repository_Session, maintaining the authoritative set of active locks, Presence_Events, Declared_Intents, dependency metadata, Coordination_Subscriptions, and Heartbeats.
3. WHEN the CoordinationHost accepts a coordination event, THE CoordinationHost SHALL assign the event a monotonically increasing Event_Revision that is unique and ordered within the Repository_Session.
4. THE CoordinationHost SHALL broadcast each accepted Coordination_Update only to the CoordinationAgents authorized for the same Repository_Session as the event.
5. THE CoordinationHost SHALL persist coordination event metadata and Audit_Records durably so that the authoritative state survives a restart of the CoordinationHost.
6. WHEN the CoordinationHost restarts, THE CoordinationHost SHALL restore the last persisted authoritative coordination state and resume assigning Event_Revisions greater than every previously assigned Event_Revision for each Repository_Session.
7. THE CoordinationHost SHALL NOT store project source contents and SHALL NOT require access to any teammate's project folder.
8. WHERE the CoordinationHost store is configured for local development, THE CoordinationHost SHALL persist coordination and audit metadata in a manner structured to permit later relocation of the store without changing the coordination behavior.

### Requirement 2: CoordinationAgent Lifecycle and Local-Only API (Phase: MVP)

**User Story:** As a developer, I want a per-user agent on my computer that connects to the host and exposes a local interface, so that my editor and AI agents can participate without administrator privileges or exposing my machine to the network.

#### Acceptance Criteria

1. WHERE the CoordinationAgent is installed for a Team_Member, THE CoordinationAgent SHALL start automatically when that Team_Member's login session begins.
2. THE CoordinationAgent SHALL run under the Team_Member's own user account without requiring administrator privileges unless an installation step genuinely requires elevated privileges.
3. WHEN the CoordinationAgent starts, THE CoordinationAgent SHALL establish exactly one outbound persistent connection to the CoordinationHost at the configured Host_URL.
4. THE CoordinationAgent SHALL expose a Local_API that is reachable only from the same computer on which the CoordinationAgent runs.
5. WHEN a client connects to the Local_API, THE CoordinationAgent SHALL accept the connection only from the same computer and SHALL reject any connection originating from another computer.
6. THE CoordinationAgent SHALL embed the Local_MCP_Server and serve it through the Local_API.
7. THE CoordinationAgent SHALL watch only the Authorized_Folder and SHALL NOT scan or watch any location on the computer outside the Authorized_Folder.
8. THE CoordinationAgent SHALL NOT upload project file contents to the CoordinationHost and SHALL NOT modify any file in the Authorized_Folder.
9. IF the CoordinationAgent cannot bind the Local_API interface, THEN THE CoordinationAgent SHALL report a startup error identifying the unavailable interface and SHALL NOT accept client connections.

### Requirement 3: VS Code Extension Responsibilities and Editor Events (Phase: MVP)

**User Story:** As a developer, I want my editor to report precise editing activity to the local agent and display coordination information, so that my teammates' agents know what I am touching and I can see warnings.

#### Acceptance Criteria

1. THE Editor_Extension SHALL communicate only with the local CoordinationAgent through the Local_API and SHALL NOT connect directly to the CoordinationHost.
2. WHEN the Team_Member opens a workspace, opens a file, changes the active editor, starts editing, saves a file, closes a file, renames a file, or deletes a file, THE Editor_Extension SHALL send a corresponding Editor_Event to the local CoordinationAgent within 2 seconds of the activity.
3. WHEN the Editor_Extension receives a Coordination_Update from the local CoordinationAgent, THE Editor_Extension SHALL update its displayed presence, locks, Declared_Intents, Planned_File_Creations, dependency impact, and offline or stale state within 2 seconds.
4. THE Editor_Extension SHALL display, for a repository-relative path being edited, the active Soft_Locks, Coordination_Required_Locks, Hard_Locks, Presence_Events, Declared_Intents, Planned_File_Creations, and indirect dependency risk affecting that path, each with the contributing Team_Member identity.
5. WHEN a repository-relative path has a hard Risk_Level and a valid winning lock is held by another Team_Member, THE Editor_Extension SHALL enforce the configured hard-stop behavior by rejecting the edit for the cooperating Team_Member.
6. WHILE the local CoordinationAgent is in Offline_State, THE Editor_Extension SHALL display an offline indicator and mark displayed coordination data as potentially stale.

### Requirement 4: Local MCP Server and Agent Tools (Phase: MVP)

**User Story:** As an AI_Agent, I want a strictly local MCP interface with tools to query risk and declare work, so that I can coordinate programmatically before I edit or create files.

#### Acceptance Criteria

1. THE Local_MCP_Server SHALL run strictly on the teammate's computer and SHALL be reachable only through the local CoordinationAgent, and SHALL NOT act as the network protocol between the AI_Agent and the CoordinationHost.
2. THE Local_MCP_Server SHALL expose the tools get_risk_map, get_dependency_impact, get_dependencies, get_dependents, declare_intent, update_intent, withdraw_intent, acquire_lock, release_lock, subscribe_to_coordination_updates, get_connection_status, and get_project_session_status.
3. WHEN an AI_Agent calls get_risk_map for a Repository_Session, THE Local_MCP_Server SHALL return, within 2 seconds, a machine-readable Risk_Map including active locks, active editing presence, Declared_Intents, Planned_File_Creations, direct conflicts, indirect dependency conflicts, the Risk_Level per affected path, the current host connectivity status, and any stale or offline state.
4. WHEN an AI_Agent calls declare_intent with a set of modify paths, a set of create paths, and a description, THE Local_MCP_Server SHALL forward the Declared_Intent to the CoordinationAgent for submission to the CoordinationHost and return a machine-readable result identifying the recorded Declared_Intent.
5. WHEN an AI_Agent calls get_dependency_impact for a set of paths, get_dependencies for a path, or get_dependents for a path, THE Local_MCP_Server SHALL return the corresponding metadata-only dependency information within 2 seconds.
6. WHEN an AI_Agent calls get_connection_status or get_project_session_status, THE Local_MCP_Server SHALL return the current CoordinationHost connectivity status and the current Repository_Session identity respectively within 2 seconds.
7. THE Local_MCP_Server SHALL return every response in a machine-readable format and SHALL include the current host connectivity status and stale or offline indication where applicable.
8. IF an AI_Agent calls a tool that mutates coordination state while the CoordinationAgent is in Offline_State, THEN THE Local_MCP_Server SHALL return a result indicating the mutation is queued or rejected and that manual coordination is required, without falsely reporting host acceptance.

### Requirement 5: Per-Device Identity, Invitation, Revocation, and Rotation (Phase: MVP)

**User Story:** As a developer, I want each of my devices to prove its identity with its own key and be admitted through a signed invitation, so that only verified devices of authorized contributors participate and a lost device can be shut out.

#### Acceptance Criteria

1. WHEN a CoordinationAgent starts and has no Device_Key, THE CoordinationAgent SHALL generate an Ed25519 Device_Key locally and store the Device_Private_Key in the OS_Credential_Store where available.
2. WHEN a Team_Admin issues a Signed_Invitation granting a device identified by its Device_Public_Key access to a Repository_Session, THE CoordinationHost SHALL validate the Signed_Invitation and, when valid, add the Device_Public_Key and its associated Team_Member identity to the Membership_Registry.
3. WHEN a CoordinationAgent connects to the CoordinationHost for a Repository_Session, THE CoordinationHost SHALL validate the device identity, the Team_Member membership, the Signed_Invitation validity, and the revocation status before admitting the CoordinationAgent.
4. IF a connecting device presents a Device_Public_Key that is absent from, or revoked in, the Membership_Registry, or presents an invalid, malformed, or expired Signed_Invitation, THEN THE CoordinationHost SHALL refuse the connection and return an authorization error code identifying the reason.
5. IF a Signed_Invitation is not signed by a Team_Admin authorized for the Repository_Session, THEN THE CoordinationHost SHALL reject the invitation, leave the Membership_Registry unchanged, and return an authorization error code indicating the issuer is not authorized.
6. WHEN a Team_Admin revokes a device's Device_Public_Key, THE CoordinationHost SHALL mark that Device_Public_Key as revoked in the Membership_Registry and SHALL reject subsequent connections and Signed_Events authenticated by that Device_Public_Key.
7. WHEN a device performs Key_Rotation by registering a new Device_Public_Key through a valid Signed_Invitation, THE CoordinationHost SHALL authenticate that device's subsequent Signed_Events against the new Device_Public_Key and retire the previous Device_Public_Key.
8. THE CoordinationAgent SHALL NOT persist the Device_Private_Key in any location readable by other users or processes on the computer.
9. IF the OS_Credential_Store is unavailable when the CoordinationAgent attempts to store or retrieve the Device_Private_Key, THEN THE CoordinationAgent SHALL report a secure-storage error and SHALL NOT connect to the CoordinationHost.

### Requirement 6: Secure Transport, Configurable Host URL, and Offline State (Phase: MVP)

**User Story:** As a developer, I want my agent to reach the host over an encrypted connection at a configurable address and to fail safe when the host is unreachable, so that my coordination data is protected and I am never misled about safety while offline.

#### Acceptance Criteria

1. THE CoordinationAgent SHALL establish its connection to the CoordinationHost as an outbound encrypted persistent connection secured with TLS.
2. THE CoordinationAgent SHALL determine the CoordinationHost address from the configured Host_URL and SHALL NOT rely on a hardcoded IP address as the only means of reaching the CoordinationHost.
3. THE CoordinationHost SHALL encrypt all client-host traffic with TLS so that coordination metadata is not readable by any party other than the connected, admitted device and the CoordinationHost.
4. IF the CoordinationAgent loses connectivity to the CoordinationHost, THEN THE CoordinationAgent SHALL enter Offline_State, mark its cached coordination data as stale, and attempt reconnection using an exponential backoff interval starting at 1 second and doubling up to a maximum of 60 seconds.
5. WHILE the CoordinationAgent is in Offline_State, THE CoordinationAgent SHALL NOT claim hard-lock safety and SHALL report through the Local_API and Local_MCP_Server that the state is offline and manual coordination is required.
6. WHEN the CoordinationAgent re-establishes connectivity to the CoordinationHost, THE CoordinationAgent SHALL leave Offline_State and clear the stale indication after synchronization completes.
7. WHERE local development runs the CoordinationHost and one or more CoordinationAgents on a single computer, THE system SHALL support a single CoordinationHost serving multiple CoordinationAgents so that a multi-agent scenario can be simulated on one computer.

### Requirement 7: Signed Events, Event IDs, Idempotency, and Replay Protection (Phase: MVP)

**User Story:** As a developer, I want every coordination event to be signed, uniquely identified, and replay-protected, so that the host only acts on authentic, non-duplicated messages.

#### Acceptance Criteria

1. WHEN the CoordinationAgent sends a coordination event to the CoordinationHost, THE CoordinationAgent SHALL create a Signed_Event carrying metadata only, signed with the Device_Private_Key, and bearing a unique Event_ID, a message-format version, and replay-protection data.
2. WHEN the CoordinationHost receives a Signed_Event, THE CoordinationHost SHALL verify the signature against the sending device's Device_Public_Key in the Membership_Registry before applying the event.
3. IF the CoordinationHost receives a Signed_Event whose signature cannot be verified against an admitted, non-revoked Device_Public_Key, THEN THE CoordinationHost SHALL discard the event and leave the authoritative coordination state unchanged.
4. IF the CoordinationHost receives a Signed_Event bearing an Event_ID it has already applied, THEN THE CoordinationHost SHALL treat the event as idempotent, apply it at most once, and return the previously assigned Event_Revision.
5. IF the CoordinationHost receives a Signed_Event whose replay-protection data indicates it is a replay of a previously processed event, THEN THE CoordinationHost SHALL reject the event and leave the authoritative coordination state unchanged.
6. IF the CoordinationHost receives a message that does not conform to the defined message schema or carries an unsupported message-format version, THEN THE CoordinationHost SHALL reject the message, return a format error code, and leave the authoritative coordination state unchanged.
7. THE CoordinationHost SHALL validate the schema and the sender's permission for every received message before applying it to the authoritative coordination state.

### Requirement 8: Monotonic Event Revisions and Conflict Resolution (Phase: MVP)

**User Story:** As a developer, I want the host to order events by an authoritative revision rather than by client clocks, so that competing claims resolve consistently for everyone.

#### Acceptance Criteria

1. WHEN the CoordinationHost accepts a coordination event, THE CoordinationHost SHALL assign it the next Event_Revision greater than every Event_Revision previously assigned for that Repository_Session.
2. THE CoordinationHost SHALL resolve competing claims for the same lock or the same Planned_File_Creation by granting the claim with the earliest assigned Event_Revision.
3. THE CoordinationHost SHALL NOT use a raw client timestamp as the sole basis for resolving a conflict between competing claims.
4. WHEN the CoordinationHost determines a claim has lost a contested lock or Planned_File_Creation, THE CoordinationHost SHALL record the losing claim as a concurrent claim and report the winning Team_Member identity and the winning Event_Revision to the affected CoordinationAgents.
5. THE CoordinationHost SHALL include the assigning Event_Revision in every Coordination_Update it broadcasts so that recipients can order updates consistently.

### Requirement 9: Reconnect-Safe Synchronization from a Known Revision (Phase: MVP)

**User Story:** As a developer, I want my agent to resynchronize from where it left off after a disconnection, so that it converges with the host without missing or re-applying updates.

#### Acceptance Criteria

1. THE CoordinationAgent SHALL record the highest Event_Revision it has applied for each Repository_Session.
2. WHEN the CoordinationAgent reconnects to the CoordinationHost, THE CoordinationAgent SHALL request synchronization from the CoordinationHost identifying the highest Event_Revision it has applied.
3. WHEN the CoordinationHost receives a synchronization request identifying a known Event_Revision, THE CoordinationHost SHALL return the coordination events with a greater Event_Revision for the Repository_Session so the CoordinationAgent converges to the authoritative state.
4. WHEN the CoordinationAgent applies synchronized events after reconnection, THE CoordinationAgent SHALL update its cached coordination state to match the authoritative state within 5 seconds of reconnection.
5. IF the CoordinationHost cannot provide incremental events from the requested Event_Revision, THEN THE CoordinationHost SHALL provide a full current snapshot of the authoritative coordination state for the Repository_Session and the CoordinationAgent SHALL replace its cached state with that snapshot.
6. WHEN the CoordinationAgent completes synchronization, THE CoordinationAgent SHALL re-assert the locks and Declared_Intents it still holds to the CoordinationHost.

### Requirement 10: Repository Session Scoping (Phase: MVP)

**User Story:** As a developer, I want coordination scoped precisely to my repository, team, branch, and worktree, so that unrelated projects and branches never mix in my Risk_Map.

#### Acceptance Criteria

1. THE CoordinationHost SHALL scope a Repository_Session using the canonical repository ID, the team ID, the Branch_Context, and the Base_Revision where available, together with normalized repository-relative paths.
2. THE CoordinationHost SHALL isolate coordination data and Dependency_Graphs per Repository_Session so that events, locks, intents, and dependency metadata from unrelated repositories, different teams, or different Branch_Contexts are never mixed unless explicitly configured.
3. WHEN a CoordinationAgent joins a Repository_Session, THE CoordinationAgent SHALL normalize repository-relative paths so that equivalent paths across Windows, macOS, and Linux resolve to the same canonical repository-relative path.
4. THE CoordinationHost SHALL account for case-sensitivity differences between platforms when matching repository-relative paths so that the same file is not treated as two distinct paths solely because of case-normalization differences.
5. WHEN a Team_Member works in a distinct branch or worktree, THE CoordinationHost SHALL treat activity under a different Branch_Context as a distinct coordination context for the same repository-relative path.
6. IF repository or version-control metadata is unavailable for the workspace, THEN THE system SHALL provide a manual Repository_Session configuration path so the Team_Member can define the session identity explicitly.
7. IF the CoordinationHost receives a coordination event whose Repository_Session identifier does not match a session the sending device is authorized for, THEN THE CoordinationHost SHALL reject the event and return an authorization error code.

### Requirement 11: Presence Broadcasting (Phase: MVP)

**User Story:** As a Team_Member, I want the files I am editing to be broadcast through the host, so that other AI_Agents can incorporate my active edits into their Risk_Map and teammates' editors can display them.

#### Acceptance Criteria

1. WHEN the Editor_Extension reports that a Team_Member has started editing a repository-relative path, THE CoordinationAgent SHALL send a Presence_Event reporting the start of editing to the CoordinationHost within 2 seconds.
2. WHEN the Editor_Extension reports that a Team_Member has closed a file or performed no edit action for longer than the configured idle threshold (between 30 and 600 seconds, defaulting to 120 seconds), THE CoordinationAgent SHALL send a Presence_Event reporting the end of editing to the CoordinationHost within 2 seconds.
3. WHEN the CoordinationHost accepts a Presence_Event, THE CoordinationHost SHALL broadcast the Presence_Event, with its Event_Revision and the reporting Team_Member identity, to the other CoordinationAgents authorized for the same Repository_Session within 2 seconds.
4. WHEN a CoordinationAgent receives a broadcast Presence_Event, THE Editor_Extension on that computer SHALL display the reporting Team_Member identity and the affected repository-relative path within 1 second of the CoordinationAgent applying the Presence_Event.
5. IF the CoordinationAgent cannot send a Presence_Event because the CoordinationHost is unreachable, THEN THE CoordinationAgent SHALL enter Offline_State and the Editor_Extension SHALL indicate that presence reporting is unavailable.

### Requirement 12: Soft Lock Acquisition and Release (Phase: MVP)

**User Story:** As a developer, I want to claim and release an advisory lock on a file I am editing, so that teammates and their AI_Agents are warned before editing the same file and know when it is free again.

#### Acceptance Criteria

1. WHEN a Team_Member opens a repository-relative path for editing, or an AI_Agent calls acquire_lock for that path, THE CoordinationAgent SHALL send a Soft_Lock request for that path to the CoordinationHost within 2 seconds.
2. WHEN the CoordinationHost receives a Soft_Lock request for a path that has no active lock, THE CoordinationHost SHALL record the Soft_Lock for the requesting Team_Member, assign it an Event_Revision, and broadcast it to the authorized CoordinationAgents within 2 seconds.
3. THE CoordinationHost SHALL record for each lock the holding Team_Member identity, the originating device, the repository-relative path or Intent_Scope (up to 4096 characters), the Branch_Context, and the assigning Event_Revision.
4. IF a Soft_Lock is requested for a path that already holds an active lock by another Team_Member under the same Branch_Context, THEN THE CoordinationHost SHALL record the new request as a concurrent claim and return the identity of the existing lock holder and the holder's Event_Revision.
5. WHEN a Team_Member closes the path, an AI_Agent calls release_lock, or the Editor_Extension detects no edit activity on the path for the configured idle threshold, THE CoordinationAgent SHALL send a Soft_Lock release request identifying the path and the holding Team_Member to the CoordinationHost.
6. WHEN the CoordinationHost receives a release request from the holding Team_Member, THE CoordinationHost SHALL remove the lock, assign the removal an Event_Revision, broadcast the release to the authorized CoordinationAgents within 2 seconds, and return a success confirmation.
7. IF the CoordinationHost receives a release request from a Team_Member who does not hold the lock, THEN THE CoordinationHost SHALL reject the request, retain the lock unchanged, and return an authorization error code indicating the requester does not hold the lock.
8. IF the CoordinationHost receives a release request for a path that has no active lock, THEN THE CoordinationHost SHALL reject the request and return an error code indicating no active lock exists for the path.

### Requirement 13: Coordination-Required Acknowledgement and Override with Audit (Phase: MVP)

**User Story:** As a developer, I want files marked coordination-required to force an explicit acknowledgement or override with a recorded reason, so that contended edits happen deliberately and are auditable.

#### Acceptance Criteria

1. WHEN an AI_Agent or Team_Member attempts to edit a repository-relative path whose Risk_Level mode is coordination-required and that path has an active lock, Declared_Intent, or Presence_Event by another Team_Member under a conflicting Branch_Context, THE system SHALL require an explicit acknowledgement or override before the edit proceeds.
2. WHEN a Team_Member or AI_Agent overrides a coordination-required restriction, THE CoordinationAgent SHALL send the override, including the Override_Reason, to the CoordinationHost.
3. WHEN the CoordinationHost accepts a coordination-required override, THE CoordinationHost SHALL record an Audit_Record identifying the overriding Team_Member and device, the affected path, and the Override_Reason.
4. IF an override for a coordination-required restriction is submitted without an Override_Reason, THEN THE system SHALL reject the override and return an error code indicating an Override_Reason is required.
5. WHEN the Local_MCP_Server reports a coordination-required path in the Risk_Map, THE Local_MCP_Server SHALL indicate that an explicit acknowledgement or override is required before editing.

### Requirement 14: Hard-Lock Enforcement by Cooperating Tools with Offline Safety Caveat (Phase: MVP)

**User Story:** As a developer responsible for critical files, I want cooperating editors and agents to reject edits to a hard-locked file held by someone else, while never being falsely told it is safe when the host is offline.

#### Acceptance Criteria

1. WHEN an AI_Agent or cooperating Editor_Extension attempts to edit a repository-relative path whose Risk_Level mode is hard and another Team_Member holds a valid winning lock on that path, THE system SHALL reject the edit and report that the path is hard-locked by another Team_Member.
2. THE system SHALL enforce hard-lock rejection through the cooperating Editor_Extension and AI agents and SHALL NOT rely on the operating system to block edits.
3. WHEN the Local_MCP_Server reports a hard-locked path in the Risk_Map, THE Local_MCP_Server SHALL report a hard Risk_Level indicating that edits are to be rejected while the winning lock exists.
4. WHILE the CoordinationAgent is in Offline_State, THE system SHALL NOT report hard-lock safety and SHALL report "Offline — manual coordination required" for any path whose Risk_Level mode is hard.
5. WHEN the CoordinationHost resolves competing hard-lock claims, THE CoordinationHost SHALL identify the single winning lock using the earliest assigned Event_Revision so that all cooperating tools enforce against the same winning holder.

### Requirement 15: Repository Rules Configuration File (Phase: MVP)

**User Story:** As a developer, I want a repository configuration file that maps paths to hard, coordination-required, or soft modes, so that the team shares a consistent policy for which files need stronger coordination.

#### Acceptance Criteria

1. THE Repository_Rules_Config SHALL map path glob patterns to a Risk_Level mode of hard, coordination-required, or soft for a Repository_Session.
2. WHEN the CoordinationAgent loads a Repository_Rules_Config for the Authorized_Folder, THE CoordinationAgent SHALL apply the configured Risk_Level mode to each repository-relative path matching a mapped glob pattern.
3. WHERE a repository-relative path matches no glob pattern in the Repository_Rules_Config, THE system SHALL apply the default soft Risk_Level mode to that path.
4. WHERE a repository-relative path matches more than one glob pattern in the Repository_Rules_Config, THE system SHALL apply the most restrictive matching Risk_Level mode, ordering hard as more restrictive than coordination-required and coordination-required as more restrictive than soft.
5. IF the Repository_Rules_Config is malformed, THEN THE CoordinationAgent SHALL report a configuration error identifying the malformed content and SHALL apply the default soft Risk_Level mode to all paths until the configuration is corrected.

### Requirement 16: Declared Intent Submit, Update, Withdraw, and Complete (Phase: MVP)

**User Story:** As a developer working with an AI assistant, I want the assistant to declare, update, withdraw, and complete its planned work, so that teammates know what will change before code is written and the plan stays accurate.

#### Acceptance Criteria

1. WHEN an AI_Agent calls declare_intent with a set of modify paths, a set of create paths, and a description, THE CoordinationHost SHALL record a Declared_Intent for the requesting Team_Member, assign it an Event_Revision, and broadcast it to the authorized CoordinationAgents within 2 seconds.
2. THE CoordinationHost SHALL record for each Declared_Intent the declaring Team_Member identity, the AI_Agent identifier, the originating device, the repository-relative modify paths, the Planned_File_Creation paths, the Branch_Context, the description, and the assigning Event_Revision.
3. WHEN an AI_Agent calls update_intent for an existing Declared_Intent it owns, THE CoordinationHost SHALL replace the modify paths, create paths, and description of that Declared_Intent, assign a new Event_Revision, and broadcast the update within 2 seconds.
4. WHEN an AI_Agent calls withdraw_intent for a Declared_Intent it owns, or completes the Declared_Intent, THE CoordinationHost SHALL remove the Declared_Intent, assign the removal an Event_Revision, and broadcast the removal within 2 seconds.
5. WHERE a Declared_Intent includes a Planned_File_Creation whose path already exists as a tracked file in the Repository_Session, THE CoordinationHost SHALL record that path as a planned modification rather than a Planned_File_Creation and return an indication that the path already exists.
6. IF an AI_Agent submits a Declared_Intent while its device is not authorized for the Repository_Session, THEN THE CoordinationHost SHALL reject the Declared_Intent and return an authorization error code.
7. IF a Declared_Intent contains a repository-relative path exceeding 4096 characters, or omits both a modify set and a create set, THEN THE CoordinationHost SHALL reject the Declared_Intent, return a format error code, and leave the authoritative state unchanged.
8. IF an AI_Agent calls update_intent or withdraw_intent for a Declared_Intent it does not own, THEN THE CoordinationHost SHALL reject the request, retain the Declared_Intent unchanged, and return an authorization error code indicating the requester does not own the Declared_Intent.

### Requirement 17: Declared Intent Reconciliation with Real Saves (Phase: MVP)

**User Story:** As a developer, I want declared intent to reconcile with the files actually saved and created, so that the shared plan reflects reality as work proceeds.

#### Acceptance Criteria

1. WHEN the Editor_Extension reports an actual save on a repository-relative path listed as a planned modification in the Team_Member's active Declared_Intent, THE CoordinationAgent SHALL report the modification as in-progress to the CoordinationHost, which SHALL update the Declared_Intent and broadcast the change within 2 seconds.
2. WHEN the filesystem watcher on the Authorized_Folder confirms creation of a file at a path listed as a Planned_File_Creation in an active Declared_Intent, THE CoordinationHost SHALL record the path as a created tracked file, remove the corresponding Planned_File_Creation, and broadcast the update within 2 seconds.
3. WHEN the filesystem watcher confirms creation of a file at a path not listed in any active Declared_Intent, THE CoordinationHost SHALL record the path as a created tracked file and broadcast the created tracked file within 2 seconds.
4. THE CoordinationAgent SHALL rely on Editor_Events for open-file and active-typing signals and SHALL rely on the filesystem watcher only to confirm persisted saved, created, renamed, and deleted files, and SHALL NOT infer open files or active typing from the filesystem watcher alone.
5. WHEN a Team_Member withdraws a Planned_File_Creation that has not been created, THE CoordinationHost SHALL remove that Planned_File_Creation and broadcast the removal within 2 seconds.

### Requirement 18: Planned File Creation Collision Detection (Phase: MVP)

**User Story:** As a developer, I want the system to detect when two members plan to create the same new file, so that duplicate or conflicting file creation is surfaced before it happens.

#### Acceptance Criteria

1. IF a Planned_File_Creation is declared for a repository-relative path that is already an active Planned_File_Creation declared by another Team_Member under the same Branch_Context, THEN THE CoordinationHost SHALL record the later declaration as a concurrent Planned_File_Creation claim and report the identity of the Team_Member holding the winning Planned_File_Creation and its Event_Revision.
2. WHEN the CoordinationHost detects a concurrent Planned_File_Creation claim, THE CoordinationHost SHALL broadcast a Planned_File_Creation conflict notification identifying the conflicting path and the declaring Team_Member identities to the authorized CoordinationAgents within 2 seconds.
3. WHEN two or more Planned_File_Creation declarations for the same path with no active Planned_File_Creation are accepted, THE CoordinationHost SHALL attribute the Planned_File_Creation to the declaration with the earliest assigned Event_Revision and record each remaining declaration as a concurrent claim.

### Requirement 19: Dependency Graph Build, Snapshot, and Deltas (Metadata Only) (Phase: MVP)

**User Story:** As an AI_Agent, I want the local agent to build a metadata-only dependency graph and share only what the host needs, so that indirect conflicts can be detected without ever transmitting source contents.

#### Acceptance Criteria

1. WHEN a Team_Member authorizes the CoordinationAgent to watch the Authorized_Folder, THE CoordinationAgent SHALL build and cache a metadata-only Dependency_Graph locally from the Authorized_Folder.
2. THE Dependency_Graph SHALL contain only Repository_Snapshot_Metadata, Package_Dependency_Metadata, Module_Dependency_Metadata, Public_Contract_Fingerprints, and Change_Delta_Metadata, and SHALL NOT contain any project source contents.
3. WHEN the CoordinationAgent determines the CoordinationHost lacks a Dependency_Graph for the same repository session ID, Branch_Context, and Base_Revision, THE CoordinationAgent SHALL send the initial Dependency_Graph snapshot to the CoordinationHost.
4. WHEN imports, manifests, lockfiles, schemas, Public_Contract_Fingerprints, migrations, or build configuration change in the Authorized_Folder, THE CoordinationAgent SHALL send incremental Change_Delta_Metadata to the CoordinationHost rather than a full graph.
5. THE CoordinationAgent SHALL NOT repeatedly upload full Dependency_Graphs from every client for a repository session that the CoordinationHost already holds at the same Branch_Context and Base_Revision.
6. WHEN the CoordinationAgent records a Dependency_Edge for a dynamic import or reflection-based dependency, THE CoordinationAgent SHALL mark that Dependency_Edge with a confidence of low or unknown.
7. THE CoordinationAgent SHALL exclude binaries, build outputs, caches, vendor folders, node_modules, virtual environments, and secrets from the Dependency_Graph.

### Requirement 20: Dependency Graph Storage per Session and Branch (Phase: MVP)

**User Story:** As a developer, I want dependency graphs stored separately per repository session and branch, so that analysis for one branch never contaminates another.

#### Acceptance Criteria

1. THE CoordinationHost SHALL store each Dependency_Graph separately per Repository_Session, keyed by repository session ID, Branch_Context, and Base_Revision.
2. WHEN the CoordinationHost receives Change_Delta_Metadata for a Repository_Session, THE CoordinationHost SHALL apply the delta only to the Dependency_Graph stored for the matching repository session ID, Branch_Context, and Base_Revision.
3. THE CoordinationHost SHALL NOT combine Dependency_Edges or Public_Contract_Fingerprints from different Branch_Contexts or different repository sessions when assessing risk unless explicitly configured.
4. THE Dependency_Graph SHALL serialize and deserialize such that a serialized-then-deserialized Dependency_Graph represents an equivalent set of Repository_Snapshot_Metadata, Package_Dependency_Metadata, Module_Dependency_Metadata, and Public_Contract_Fingerprints (round-trip property).

### Requirement 21: Direct File Conflict Detection (Phase: MVP)

**User Story:** As an AI_Agent, I want the host to flag when I target a file another member is already changing or plans to change, so that I avoid direct collisions.

#### Acceptance Criteria

1. WHEN a repository-relative path has an active Soft_Lock, Coordination_Required_Lock, Hard_Lock, Presence_Event, or Declared_Intent by another Team_Member under a conflicting Branch_Context, THE CoordinationHost SHALL classify that path as a direct conflict.
2. WHEN the Local_MCP_Server reports a direct conflict in the Risk_Map, THE Local_MCP_Server SHALL identify the affected path, the contributing Team_Member identities, and the type of contention.
3. WHEN two Team_Members hold active locks or Declared_Intents on the same repository-relative path under different Branch_Contexts, THE CoordinationHost SHALL assess the situation as reduced or no direct conflict and report the distinct Branch_Contexts.

### Requirement 22: Indirect and Reverse-Dependency Conflict Detection (Phase: MVP)

**User Story:** As an AI_Agent, I want to be warned when a file I am changing depends on, or is depended on by, a file another member is changing, so that I catch breakage that direct file conflicts alone would miss.

#### Acceptance Criteria

1. WHEN one Team_Member changes a repository-relative path and another Team_Member changes a path connected to it through a Dependency_Edge in the Dependency_Graph, THE CoordinationHost SHALL classify both paths as having an indirect dependency-risk conflict.
2. WHEN a repository-relative path being changed is a dependency of another path (a reverse-dependency relationship in the Dependency_Graph), THE CoordinationHost SHALL identify the dependent paths as reverse-dependency risks.
3. WHEN two Team_Members change paths that share the same Public_Contract_Fingerprint, exported schema, database schema, API schema, or migration identifier, THE CoordinationHost SHALL classify the situation as a shared-contract conflict.
4. WHEN the Local_MCP_Server reports an indirect dependency-risk conflict, THE Local_MCP_Server SHALL include the confidence of the Dependency_Edges contributing to the risk.
5. WHERE the Dependency_Edges contributing to an indirect risk have a confidence of low or unknown, THE Local_MCP_Server SHALL report the indirect risk with that confidence rather than as a confirmed conflict.

### Requirement 23: Dependency Impact Reports (Phase: MVP)

**User Story:** As an AI_Agent, I want an impact report for a set of paths, so that I can see everything my planned change could affect before I start.

#### Acceptance Criteria

1. WHEN an AI_Agent calls get_dependency_impact for a set of repository-relative paths, THE Local_MCP_Server SHALL return a Dependency_Impact_Report identifying the direct dependencies, the reverse dependencies, and the shared public contracts affected by those paths within 2 seconds.
2. WHEN an AI_Agent calls get_dependencies for a repository-relative path, THE Local_MCP_Server SHALL return the paths that the given path depends on according to the Dependency_Graph.
3. WHEN an AI_Agent calls get_dependents for a repository-relative path, THE Local_MCP_Server SHALL return the paths that depend on the given path according to the Dependency_Graph.
4. THE Dependency_Impact_Report SHALL include, for each affected path, the resulting Risk_Level and an explanation path describing the Dependency_Edges or shared contracts that produced the risk.
5. IF a requested path is absent from the Dependency_Graph, THEN THE Local_MCP_Server SHALL return an empty impact result for that path and indicate the path is not present in the Dependency_Graph.

### Requirement 24: Risk Level Classification with Explanation Paths (Phase: MVP)

**User Story:** As an AI_Agent, I want each relevant path classified into an actionable risk level with an explanation, so that I can decide programmatically whether to proceed, coordinate, or stop.

#### Acceptance Criteria

1. WHEN an AI_Agent calls get_risk_map for a Repository_Session, THE Local_MCP_Server SHALL assign each relevant repository-relative path or Intent_Scope a Risk_Level of soft, coordination-required, or hard within 2 seconds.
2. WHEN a path has a hard Risk_Level mode in the Repository_Rules_Config and is contended by another Team_Member under a conflicting Branch_Context, THE Local_MCP_Server SHALL classify that path as hard.
3. WHEN a path has a coordination-required Risk_Level mode in the Repository_Rules_Config and is contended by another Team_Member under a conflicting Branch_Context, THE Local_MCP_Server SHALL classify that path as coordination-required.
4. WHEN a path has only a Presence_Event, an advisory Soft_Lock, a non-conflicting Declared_Intent, or an indirect dependency risk by another Team_Member, and no hard or coordination-required rule applies, THE Local_MCP_Server SHALL classify that path as soft.
5. THE Local_MCP_Server SHALL derive each Risk_Level from the active locks, Declared_Intents, Presence_Events, Dependency_Graph, Repository_Rules_Config, and Branch_Context in the coordination data.
6. THE Local_MCP_Server SHALL NOT classify a path as hard or coordination-required unless a matching Repository_Rules_Config rule applies to that path.
7. WHEN the Local_MCP_Server returns the Risk_Map, THE Local_MCP_Server SHALL include, for each classified path or Intent_Scope, the assigned Risk_Level, the contributing Team_Member identities, and an explanation path describing whether the risk is direct or indirect and which Dependency_Edges or shared contracts contributed.

### Requirement 25: Pushed Real-Time Coordination Updates and Subscriptions (Phase: MVP)

**User Story:** As an AI_Agent, I want to subscribe and receive pushed updates whenever coordination data changes, so that my Risk_Map stays current without polling and I can react before I edit or create a file.

#### Acceptance Criteria

1. WHEN an AI_Agent calls subscribe_to_coordination_updates for a Repository_Session, or the Editor_Extension registers a Coordination_Subscription through the Local_API, THE CoordinationAgent SHALL register the Coordination_Subscription and return a confirmation within 2 seconds.
2. WHEN the CoordinationHost broadcasts a Coordination_Update for a Repository_Session, THE CoordinationAgent SHALL push a Coordination_Update to every subscriber for that Repository_Session within 2 seconds of applying the change.
3. THE CoordinationAgent SHALL deliver each Coordination_Update in a machine-readable format identifying the affected repository-relative path or Planned_File_Creation, the associated Team_Member identity, whether the entry was added or removed, and the assigning Event_Revision.
4. THE CoordinationAgent SHALL isolate Coordination_Updates per Repository_Session so that a subscriber receives only updates for the Repository_Session it subscribed to.
5. WHEN a subscriber cancels its Coordination_Subscription, THE CoordinationAgent SHALL remove the subscription within 2 seconds and cease pushing Coordination_Updates to that subscriber.
6. IF an unauthorized client requests a Coordination_Subscription, THEN THE CoordinationAgent SHALL reject the request, return an authorization error code, and register no subscription.

### Requirement 26: Heartbeats and Stale Lock and Intent Expiry (Phase: MVP)

**User Story:** As a developer, I want locks and intents from disconnected teammates to expire automatically, so that files do not stay locked after a teammate goes offline.

#### Acceptance Criteria

1. WHILE a CoordinationAgent is connected to the CoordinationHost, THE CoordinationAgent SHALL send a Heartbeat to the CoordinationHost at the configured Heartbeat interval, where the interval is between 5 and 60 seconds and defaults to 15 seconds.
2. WHEN the CoordinationHost receives a Heartbeat from a CoordinationAgent, THE CoordinationHost SHALL record the receipt time as the most recent Heartbeat time for that device.
3. IF the CoordinationHost receives no Heartbeat from a CoordinationAgent for a continuous duration exceeding the Lock_Expiry_Interval, THEN THE CoordinationHost SHALL release every lock and remove every Declared_Intent held by that device's Team_Member, where the Lock_Expiry_Interval is at least three times the Heartbeat interval and defaults to 45 seconds.
4. WHEN the CoordinationHost expires a lock or Declared_Intent due to a missed Heartbeat, THE CoordinationHost SHALL assign the expiry an Event_Revision and broadcast the release to the authorized CoordinationAgents within 2 seconds.
5. THE CoordinationHost SHALL treat a Soft_Lock as active from its acquisition until the lock is released, expired, or 30 minutes have elapsed since acquisition, whichever occurs first.
6. WHILE the Editor_Extension is connected to the local CoordinationAgent, THE Editor_Extension SHALL send a Heartbeat to the CoordinationAgent at the configured Heartbeat interval so the CoordinationAgent can detect a stopped editor.

### Requirement 27: Health, Diagnostics, and Peer Connectivity Reporting (Phase: MVP)

**User Story:** As an operator or developer, I want the host to expose health and diagnostics and report who is connected, so that I can monitor the coordination layer and see which teammates are online.

#### Acceptance Criteria

1. THE CoordinationHost SHALL expose a health endpoint that reports whether the CoordinationHost is operational within 2 seconds of a request.
2. THE CoordinationHost SHALL expose a diagnostics endpoint that reports the connected CoordinationAgents, the active Repository_Sessions, and the current highest Event_Revision per Repository_Session.
3. WHEN a CoordinationAgent connects to or disconnects from the CoordinationHost, THE CoordinationHost SHALL update its reported set of connected and offline participants for the affected Repository_Session.
4. WHEN an AI_Agent calls get_connection_status, THE Local_MCP_Server SHALL report the current CoordinationHost connectivity status and the set of connected and offline participants for the Repository_Session.
5. THE health and diagnostics endpoints SHALL report only operational and coordination metadata and SHALL NOT expose project source contents or secrets.

### Requirement 28: Audit Metadata (Phase: MVP)

**User Story:** As a team lead, I want an audit trail of coordination actions, so that I can see who created, changed, withdrew, or overrode a lock or intent and why.

#### Acceptance Criteria

1. WHEN the CoordinationHost creates, updates, withdraws, expires, or overrides a lock or Declared_Intent, THE CoordinationHost SHALL persist an Audit_Record identifying the Team_Member, the device, the action, the affected path or Intent_Scope, the assigning Event_Revision, and the time.
2. WHEN the CoordinationHost records an override of a coordination-required or hard restriction, THE CoordinationHost SHALL include the Override_Reason in the Audit_Record.
3. THE Audit_Record SHALL NOT contain project source contents, secrets, or absolute local filesystem paths.
4. THE CoordinationHost SHALL retain Audit_Records durably so that they survive a restart of the CoordinationHost.

### Requirement 29: Data Minimization (Phase: MVP)

**User Story:** As a security-conscious developer, I want the system to never send my source code, secrets, or private paths by default, so that coordination cannot leak sensitive project data.

#### Acceptance Criteria

1. THE CoordinationAgent SHALL NOT transmit to the CoordinationHost any project source-code contents, .env file contents, passwords, API keys, tokens, or certificates.
2. THE CoordinationAgent SHALL NOT transmit absolute local filesystem paths, node_modules, virtual environments, build output, caches, Git internals, or user data located outside the Authorized_Folder.
3. THE CoordinationAgent SHALL transmit only coordination metadata and Dependency_Graph metadata, using normalized repository-relative paths, to the CoordinationHost.
4. IF a coordination event or Dependency_Graph delta would include content excluded by data minimization, THEN THE CoordinationAgent SHALL omit that content before transmission.
5. THE CoordinationHost SHALL reject any received message that carries project source contents or secrets and SHALL return a format error code.

### Requirement 30: File Rename, Move, and Deletion Handling (Phase: MVP)

**User Story:** As a developer, I want coordination to follow files when they are renamed, moved, or deleted, so that locks, intents, and dependency edges stay accurate instead of pointing at stale locations.

#### Acceptance Criteria

1. WHEN the Editor_Extension or filesystem watcher confirms a rename or move of a repository-relative path, THE CoordinationAgent SHALL send a path-change notification identifying the old and new repository-relative paths to the CoordinationHost within 2 seconds.
2. WHEN the CoordinationHost receives a path-change notification for a path that holds an active lock by the same Team_Member, THE CoordinationHost SHALL transfer that lock to the new path, retaining the holding Team_Member identity, and assign the change an Event_Revision.
3. WHEN the CoordinationHost processes a rename or move, THE CoordinationHost SHALL update every active Declared_Intent and Dependency_Edge that references the old path so it references the new path, and treat the change as affecting both the old and new paths.
4. WHEN the Editor_Extension or filesystem watcher confirms a deletion of a repository-relative path, THE CoordinationAgent SHALL send a deletion notification to the CoordinationHost within 2 seconds.
5. WHEN the CoordinationHost receives a deletion notification, THE CoordinationHost SHALL release any active lock on that path held by the deleting Team_Member and remove references to that path from that Team_Member's active Declared_Intents.
6. WHEN the CoordinationHost records a rename, move, or deletion, THE CoordinationHost SHALL broadcast the resulting Coordination_Update to the authorized CoordinationAgents within 2 seconds.
7. IF a path-change or deletion notification references a path with no lock or Declared_Intent reference, THEN THE CoordinationHost SHALL update the tracked path set without altering any lock or Declared_Intent and return a success confirmation.

### Requirement 31: Multiple Local Clients per User (Phase: MVP)

**User Story:** As a developer who runs several editor windows and agents on one computer, I want the local agent to coordinate all of them coherently, so that my own windows do not appear to conflict with each other and the host sees one consistent view of me.

#### Acceptance Criteria

1. WHEN more than one Editor_Extension or AI_Agent belonging to the same Team_Member on the same computer connects to the local CoordinationAgent, THE CoordinationAgent SHALL accept and serve all of them concurrently under that Team_Member's identity.
2. WHEN two local clients of the same Team_Member report editing activity or request a lock on the same repository-relative path, THE CoordinationAgent SHALL treat the activity as belonging to a single Team_Member and SHALL NOT record a concurrent claim between those local clients.
3. WHEN the CoordinationAgent sends Presence_Events, locks, or Declared_Intents originating from any of its local clients, THE CoordinationAgent SHALL represent them to the CoordinationHost under the single Team_Member identity and single device of the computer.
4. WHEN a local client of the Team_Member disconnects while another local client of the same Team_Member still references the same path, THE CoordinationAgent SHALL retain the associated locks, Presence_Events, and Declared_Intents until no local client of that Team_Member references the path.
5. WHEN the Local_MCP_Server serves a Risk_Map to one of the Team_Member's own AI_Agents, THE Local_MCP_Server SHALL exclude that Team_Member's own active locks and Declared_Intents from the querying AI_Agent's Risk_Map so the Team_Member's own activity is not reported as a risk against itself.

### Requirement 32: Directory and Glob Scoped Intents and Locks (Phase: MVP)

**User Story:** As an AI_Agent, I want to declare intent and hold advisory scope over a folder or a pattern of files, so that I can signal work across an area without locking each file individually.

#### Acceptance Criteria

1. WHEN an AI_Agent submits a Declared_Intent or lock request with an Intent_Scope expressed as a repository-relative folder path or a glob pattern, THE CoordinationHost SHALL record it against that Intent_Scope, assign an Event_Revision, and broadcast it within 2 seconds.
2. THE CoordinationHost SHALL treat a repository-relative path as covered by a scoped lock or scoped Declared_Intent WHEN the path is contained within the folder path or matches the glob pattern of that Intent_Scope.
3. WHEN the Local_MCP_Server reports the Risk_Map for a repository-relative path, THE Local_MCP_Server SHALL include every active scoped lock and scoped Declared_Intent whose Intent_Scope covers that path, each with its holding or declaring Team_Member identity and Intent_Scope.
4. IF a Declared_Intent or lock request specifies a malformed glob pattern, THEN THE CoordinationHost SHALL reject the request, return a format error code, and leave the authoritative state unchanged.
5. THE CoordinationHost SHALL limit an Intent_Scope to a single repository-relative file path, a repository-relative folder path, or a glob pattern, and SHALL NOT interpret higher-level semantic scopes such as components, migrations, or API contracts.

### Requirement 33: Offline Degradation with Staleness Marking (Phase: MVP)

**User Story:** As a developer with an intermittent connection, I want my agent and editor to keep working from the last-known state while offline and clearly know it may be stale, so that I can still make informed decisions and reconcile when I reconnect.

#### Acceptance Criteria

1. WHILE the CoordinationAgent is in Offline_State, THE Local_MCP_Server SHALL continue to serve Risk_Map and coordination queries from the last-known cached coordination data.
2. WHILE the CoordinationAgent is in Offline_State, THE Local_MCP_Server SHALL include a staleness indicator in every Risk_Map and coordination response reporting the data as potentially stale and the time since the last successful synchronization.
3. WHILE the CoordinationAgent is in Offline_State, THE Editor_Extension SHALL continue to display the last-known coordination data marked as potentially stale.
4. WHEN the CoordinationAgent re-establishes connectivity to the CoordinationHost, THE CoordinationAgent SHALL synchronize its cached coordination data from the authoritative state within 5 seconds.
5. WHEN the CoordinationAgent completes synchronization after reconnection, THE Local_MCP_Server SHALL clear the staleness indicator from subsequent responses.

### Requirement 34: Rate Limiting and Deduplication of Coordination Events (Phase: MVP)

**User Story:** As a developer, I want rapid bursts of presence and lock changes to be smoothed out, so that quickly opening many files or toggling activity does not flood the host.

#### Acceptance Criteria

1. WHEN a client generates more Presence_Events or lock changes than the configured burst threshold within a coalescing window, where the window is between 1 and 10 seconds and defaults to 2 seconds, THE CoordinationAgent SHALL coalesce the events per repository-relative path so that only the most recent state for that path is sent to the CoordinationHost.
2. IF the CoordinationAgent produces two or more identical Presence_Events or lock changes for the same path and Team_Member within the coalescing window, THEN THE CoordinationAgent SHALL send the change once and discard the redundant duplicates.
3. WHEN the CoordinationAgent coalesces or deduplicates events, THE CoordinationAgent SHALL preserve the final resulting state for each affected path so that the transmitted coordination data reflects the Team_Member's latest activity.
4. WHILE a Team_Member's coordination-event rate exceeds the configured burst threshold, THE CoordinationAgent SHALL continue to accept the events locally and SHALL bound the outbound rate to the CoordinationHost to the configured limit.

### Requirement 35: Local Cached and Encrypted Coordination State (Phase: MVP)

**User Story:** As a developer, I want my agent to cache coordination state locally and securely, so that I have offline visibility and fast reconnection without exposing data to other users on my machine.

#### Acceptance Criteria

1. THE CoordinationAgent SHALL cache the coordination data and highest applied Event_Revision for each Repository_Session locally so it can serve queries and resynchronize after a restart or reconnection.
2. THE CoordinationAgent SHALL store its local cached coordination state encrypted so that it is not readable by other users on the computer.
3. WHEN the CoordinationAgent restarts, THE CoordinationAgent SHALL load its cached coordination state and mark it as potentially stale until synchronization with the CoordinationHost completes.
4. THE local cached coordination state SHALL NOT contain project source contents or secrets.

### Requirement 36: Future Extensions (Phase: Future)

**User Story:** As a team planning beyond the MVP, I want the deferred capabilities recorded, so that the architecture accommodates them without contradicting the MVP.

#### Acceptance Criteria

1. WHERE direct peer-to-peer connections are enabled in a future phase, THE system SHALL allow CoordinationAgents to exchange coordination data directly while preserving the authoritative ordering guarantees defined for the MVP. (Phase: Future)
2. WHERE network-address-translation traversal is enabled in a future phase, THE system SHALL establish connectivity between CoordinationAgents on different networks. (Phase: Future)
3. WHERE local-network discovery is enabled in a future phase, THE system SHALL locate CoordinationAgents on the same local network. (Phase: Future)
4. WHERE additional IDEs beyond Visual Studio Code are supported in a future phase, THE additional editor clients SHALL communicate only with the local CoordinationAgent. (Phase: Future)
5. WHERE additional operating-system platforms beyond the first Windows target are supported in a future phase, THE CoordinationAgent SHALL preserve the local-only API and data-minimization guarantees defined for the MVP. (Phase: Future)
6. WHERE a service-based startup model (Windows Service, macOS launchd, or Linux systemd) is adopted in a future phase, THE CoordinationAgent SHALL continue to run under the Team_Member's authority without requiring administrator privileges unless genuinely necessary. (Phase: Future)
7. WHERE the CoordinationHost store is migrated to PostgreSQL in a future phase, THE CoordinationHost SHALL preserve the coordination and audit behavior defined for the MVP. (Phase: Future)
8. WHERE higher-level semantic lock scopes (component, migration, or API-contract level) are introduced in a future phase, THE system SHALL extend Intent_Scope beyond file, folder, and glob scopes while retaining the metadata-only dependency approach defined for the MVP. (Phase: Future)
