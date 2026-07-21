# CFLS Collaborative File Lock Sync

Editor extension for the Collaborative File Lock Sync MVP. It connects only to
the local CoordinationAgent and shows a clickable CFLS team status item in the
status bar. Select it (or run **CFLS: Show Coordination Status**) to open the
live connected/offline team roster, plus each active member's task and
repository-relative file metadata, alongside presence, locks, declared intents,
and coordination warnings.

The panel never sends or renders source text, patches, or diffs. Start the local
Agent first; the extension uses its authenticated loopback API and never connects
directly to the team Host.
