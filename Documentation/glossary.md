# CFLS — Glossary

Plain definitions of every term used across the documents.

- **System (`C1`, `C2`, …)** — one machine running the always-on Service. Each machine has a unique system id.
- **Agent (`A1`, `A2`, …)** — one AI worker agent, numbered within its system. Multiple agents can run on one system (`A1`, `A2`, …).
- **Global address (`C1/A1`)** — the unique, session-wide address of an agent: its system + its agent id.
- **Service** — the always-awake background process on each machine. Watches disk + git, holds the one connection to the Host, routes messages, holds mailboxes, caches state. "Dumb muscle."
- **Extension** — the IDE plug-in: the live in-editor sensor (unsaved edits, focus, terminal, errors) and the human's status bar + panel. Talks only to the local Service.
- **Agent Interface** — the tool-based protocol an agent uses to speak (checkpoint, sync, message, ask-and-wait, declare intent, get status). The agent's "voice."
- **Host** — the single, central source of truth: strict event ordering, identity/membership, broadcast, persistence, restart recovery. One per session.
- **Luna** — the single central orchestrator agent (the "PM"), living at the Host. Assigns/routes tasks by judgment, arbitrates conflicts, answers cross-agent questions, summarizes team state. Proposes; humans approve.
- **Director** — the human role: sets direction, assigns big work via Luna, approves incoming work, watches status, wakes idle agents.
- **Awareness** — the automatically-detected, real-time picture of who is working on what. Free; requires no agent action.
- **Intent** — an agent's one-time declaration at task start of the area/files it plans to change and any files it plans to create. Proactive; covers what detection can't (not-yet-existing files, and "before" timing).
- **Lock** — an explicit exclusive claim on a file. Rare; used only for files where simultaneous edits would be catastrophic.
- **Live workspace state** — the single merged picture (Extension signals + disk/git truth + agent declarations) kept in sync for every participant.
- **Diff pipeline** — our own mechanism that streams the editor's live unsaved change ranges and reconciles them against the git baseline (uses proven diff computation underneath). Gives a real-time "changes forming" layer.
- **Checkpoint** — the agent's "before I edit" step: it calls `checkpoint(files)`, which returns pending mail/tasks + who else is on those files. The main moment coordination is delivered.
- **Sync** — the agent's "after a task" step: publish what it did, mark the task done, pull the next task.
- **Piggyback delivery** — messages/tasks ride along, stapled to the reply of a tool the agent was already calling (e.g., checkpoint). No separate "check messages" step, near-zero cost.
- **Ask-and-wait** — a bounded blocking call: an agent sends a question and waits; it returns the instant the reply lands, or on timeout (then Luna decides).
- **Idle bridge** — the path for reaching a sleeping agent: queue the message to its mailbox and alert its machine's human (by severity/sound) to resume it.
- **Mailbox** — a per-agent queue held by the Service where incoming messages/tasks wait until the agent next acts.
- **Task file** — an agent's own task list (a simple file it reads). Synced live through the Host, shown in the panel, not committed to git.
- **Presence** — "who is connected and generally active," part of the live state.
- **Liveness** — availability status. **System liveness:** `online` / `offline`. **Agent liveness:** `active` (recently working), `idle` (connected but turn ended / asleep), `gone` (its system is offline).
- **Priority** — a message's urgency: `fyi` (silent badge), `normal` (soft sound + highlight), `urgent` (loud/repeating alert + resume prompt). Luna can raise priority when the team is blocked.
- **Proposes, humans dispose** — Luna suggests assignments; the receiving machine's human approves before work lands.
- **Graceful degradation** — if Luna/Host is unavailable, basic coordination continues via humans + simple rules; orchestration resumes on recovery.
- **Content boundary** — the rule that team work (diffs/messages/plans) is shared within the team, but secrets, credentials, environment files, and out-of-project content are never shared.
- **Split-brain** — the failure mode (avoided) where more than one orchestrator makes conflicting decisions. Prevented by having exactly one central Luna.
