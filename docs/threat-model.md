# Security & Threat Model

> Living threat-model doc for **Collaborative File Lock Sync (Host-Based MVP)**.
> Seeded from the design's "Security & Threat Model" section.
> Related docs: [architecture.md](./architecture.md) · [protocol.md](./protocol.md) ·
> [deployment.md](./deployment.md)

## Trust Boundaries

- **Local zone (loopback only):** Editor_Extension ↔ Local_API ↔ agent ↔ Local_MCP_Server ↔
  AI_Agent. Never network-reachable.
- **Network zone (WSS/TLS):** the single authenticated agent↔host channel.
- **Host zone:** CoordinationHost + metadata store.

## Identity, Invitation, Roles, Revocation, Rotation

- **Per-device Ed25519 identity:** the private key is generated locally and stored in the OS
  credential store (Windows Credential Manager via `keytar`) with an **encrypted-file
  fallback**; never readable by other users/processes. If the store is unavailable, the agent
  reports a secure-storage error (`SECURE_STORAGE_UNAVAILABLE`) and **does not connect**
  (fail closed).
- **Signed_Invitation:** issued by a `Team_Admin` device; the host validates that the
  invitation signature chains to an authorized admin for the session before adding the device
  to the `Membership_Registry`. Invitations from non-admins are rejected
  (`AUTH_ISSUER_NOT_ADMIN`).
- **Revocation:** an admin revokes a `Device_Public_Key`; the host thereafter rejects that
  key's connections and Signed_Events (`AUTH_INVALID_DEVICE`).
- **Key rotation:** a device registers a new key via a valid invitation; the host
  authenticates subsequent events against the new key and retires the old.

## Transport, Signing, Replay, Local API Auth

- **TLS everywhere** on the network channel.
- **Event signing/verification:** every event is Ed25519-signed; the host verifies before
  applying.
- **Replay protection:** per-device monotonic counter + nonce; idempotent by `Event_ID`.
- **Local API auth:** loopback-only bind + per-session `Local_Auth_Token`; non-loopback
  origins rejected; unauthorized subscription requests rejected.
- **Data minimization enforcement:** the agent strips excluded content before send; the host
  rejects any message carrying source/secrets with a `FORMAT_ERROR`.

The wire-level mechanics of these gates (envelope, handshake, replay counter) are documented
in [protocol.md](./protocol.md).

## Offline-Safety Rule

While offline the system **never claims hard-lock safety**. For any hard-mode path it reports
`"Offline — manual coordination required"`. Cached data is served but marked stale with
time-since-sync. Mutations attempted while offline are queued or rejected without falsely
reporting host acceptance.

## Data-Minimization Guarantee

**No source content is ever transmitted.** The dependency analyzer performs static,
metadata-only analysis: it extracts import specifiers, manifest fields, and computes
fingerprints/hashes. It never reads or transmits file bodies, comments, string literals
beyond import specifiers, secrets, or absolute paths.

Always excluded from watching, analysis, and transmission: `node_modules`, build outputs
(`dist`, `build`, `out`), caches, `.git` internals, vendor folders, virtual environments
(`venv`, `.venv`), binaries, and any secret files (`.env`, key/cert files). A pre-transmission
filter drops any field that would carry excluded content, and the host rejects inbound
messages that violate this.

## STRIDE Threat Table

| Threat | Vector | Mitigation |
|---|---|---|
| **Spoofing** | Impersonate a device/member | Ed25519 challenge-response handshake; membership + invitation validation |
| **Tampering** | Modify events in transit / at rest | TLS + per-event Ed25519 signatures verified before apply; host is sole revision authority |
| **Repudiation** | Deny an override/action | Durable Audit_Records with member, device, action, revision, time, Override_Reason |
| **Information disclosure** | Leak source/secrets/paths | Metadata-only guarantee; exclusion list; agent strip + host reject; loopback-only Local_API |
| **Denial of service** | Event floods | Client-side coalescing/dedup + bounded outbound rate; replay counter caps duplicates |
| **Elevation of privilege** | Non-admin issues invitations / non-holder releases lock | Admin-authorized invitation check; holder/owner checks on release/update/withdraw |

## Audit & Overrides

Editing a coordination-required path that is contended requires an explicit
acknowledgement/override. The override must include an `Override_Reason`; a missing reason is
rejected (`OVERRIDE_REASON_REQUIRED`). Accepted overrides write a durable Audit_Record with
member, device, path, revision, time, and reason — never any source content.

## Relevant Error Codes

```typescript
type ErrorCode =
  | 'AUTH_INVALID_DEVICE'      // unknown/revoked key, bad invitation
  | 'AUTH_ISSUER_NOT_ADMIN'    // invitation not signed by authorized admin
  | 'AUTH_SESSION_FORBIDDEN'   // event for unauthorized session
  | 'AUTH_NOT_AUTHORIZED'      // generic authorization failure
  | 'FORMAT_ERROR'             // schema/version/glob/oversize/content violation
  | 'NOT_OWNER'                // update/withdraw intent not owned
  | 'NOT_LOCK_HOLDER'          // release by non-holder
  | 'NO_ACTIVE_LOCK'           // release with no lock
  | 'NOT_FOUND'                // unknown intent/lock/session
  | 'OVERRIDE_REASON_REQUIRED' // coordination-required override w/o reason
  | 'OFFLINE_QUEUED'           // mutation queued while offline
  | 'STORAGE_ERROR'            // persistence failure
  | 'SECURE_STORAGE_UNAVAILABLE'; // OS credential store missing
```
