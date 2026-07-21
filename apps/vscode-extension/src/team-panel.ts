/**
 * Self-contained webview markup for the live CFLS team coordination panel.
 *
 * The panel intentionally renders all dynamic values with `textContent` in the
 * webview script. The initial state is JSON-escaped before being embedded, so a
 * member name or declared task can never break out into executable markup.
 */

import type { CoordinationViewModel } from "./view-model";
import type { LocalDiffPreview } from "./local-diff-preview";

/** Local-only state supplied by the VS Code adapter, never by the host. */
export interface TeamPanelLocalState {
  selfMemberId: string;
  localDiffPreview?: LocalDiffPreview;
}

/** Serialize data safely for an inline script element. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Build the webview document for a live, member-selectable team panel. */
export function buildTeamPanelHtml(
  viewModel: CoordinationViewModel,
  teamName: string,
  localState: TeamPanelLocalState = { selfMemberId: "self" },
): string {
  const initialState = safeJson({ viewModel, teamName, ...localState });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>CFLS Team Coordination</title>
  <style>
    :root { color-scheme: light dark; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--vscode-editor-background); }
    .header { display: flex; align-items: center; gap: 10px; padding: 18px 22px; border-bottom: 1px solid var(--vscode-panel-border); background: linear-gradient(110deg, color-mix(in srgb, var(--vscode-editor-background) 88%, #4d9fff), var(--vscode-editor-background)); }
    .mark { width: 30px; height: 30px; flex: none; }
    .title { min-width: 0; }
    h1 { margin: 0; font-size: 16px; font-weight: 700; }
    .subtle { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .state { margin-left: auto; font-size: 12px; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); }
    .state.offline { color: var(--vscode-errorForeground); }
    .state.stale { color: var(--vscode-editorWarning-foreground); }
    .layout { display: grid; grid-template-columns: minmax(190px, 30%) minmax(0, 1fr); min-height: calc(100vh - 71px); }
    .members { border-right: 1px solid var(--vscode-panel-border); padding: 14px 10px; }
    .members-label { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .08em; margin: 0 8px 8px; text-transform: uppercase; }
    .member { appearance: none; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; display: flex; gap: 9px; align-items: center; text-align: left; width: 100%; padding: 9px; border-radius: 6px; font: inherit; }
    .member:hover, .member.selected { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
    .avatar { align-items: center; background: var(--vscode-button-secondaryBackground); border-radius: 50%; display: inline-flex; flex: none; font-size: 12px; font-weight: 700; height: 26px; justify-content: center; width: 26px; }
    .member-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .member-meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; }
    .detail { padding: 22px; }
    .detail h2 { font-size: 18px; margin: 0 0 4px; }
    .section { margin-top: 24px; }
    .section h3 { color: var(--vscode-descriptionForeground); font-size: 11px; letter-spacing: .08em; margin: 0 0 8px; text-transform: uppercase; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 7px; margin-bottom: 8px; overflow: hidden; }
    .card-title { font-size: 13px; font-weight: 600; padding: 9px 11px 0; }
    .card-body { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; padding: 4px 11px 10px; white-space: pre-wrap; }
    .file-row { align-items: center; display: flex; gap: 8px; min-height: 32px; padding: 7px 10px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent); }
    .file-row:last-child { border-bottom: 0; }
    code { color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); font-size: 12px; overflow-wrap: anywhere; }
    .roles { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
    .tag { background: var(--vscode-badge-background); border-radius: 10px; color: var(--vscode-badge-foreground); font-size: 10px; padding: 2px 6px; }
    .empty { color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.55; padding: 15px 8px; }
    .privacy { background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); border-left: 3px solid var(--vscode-editorWarning-foreground); color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; padding: 10px 12px; }
    .diff-card { border: 1px solid var(--vscode-panel-border); border-radius: 7px; overflow: hidden; }
    .diff-meta { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    .diff-preview { background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.5; margin: 0; overflow-x: auto; padding: 6px 0; }
    .diff-line { display: grid; grid-template-columns: 22px minmax(0, 1fr); min-width: max-content; padding: 1px 10px; white-space: pre; }
    .diff-line.added { background: color-mix(in srgb, var(--vscode-testing-iconPassed) 16%, transparent); }
    .diff-line.removed { background: color-mix(in srgb, var(--vscode-testing-iconFailed) 16%, transparent); }
    .diff-prefix { color: var(--vscode-descriptionForeground); user-select: none; }
    .diff-line.added .diff-prefix { color: var(--vscode-testing-iconPassed); }
    .diff-line.removed .diff-prefix { color: var(--vscode-testing-iconFailed); }
    @media (max-width: 560px) { .layout { grid-template-columns: 1fr; } .members { border-bottom: 1px solid var(--vscode-panel-border); border-right: 0; } }
  </style>
</head>
<body>
  <header class="header">
    <svg class="mark" viewBox="0 0 32 32" aria-label="CFLS logo" role="img"><path fill="#62e6e0" d="M16 2 29 9.5v13L16 30 3 22.5v-13L16 2Zm0 5.1L7.5 12v8L16 24.9l8.5-4.9v-8L16 7.1Z"/><path fill="#d6f54a" d="M14 11h8v3h-5v4h4v3h-7V11Z"/></svg>
    <div class="title"><h1 id="team-title">CFLS</h1><div class="subtle" id="team-subtitle"></div></div>
    <div class="state" id="connection-state"></div>
  </header>
  <main class="layout">
    <aside class="members"><div class="members-label">Team members</div><div id="member-list"></div></aside>
    <section class="detail" id="member-detail"></section>
  </main>
  <script>
    const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
    let state = ${initialState};
    let selectedMemberId = null;
    const roleLabel = { editing: "editing", "soft-lock": "lock", intent: "intent", "planned-create": "new file" };
    const connectionLabel = { connected: "Connected", offline: "Offline", unknown: "Roster pending" };
    const diffPrefix = { added: "+", removed: "−", context: " " };
    const el = (tag, className) => { const node = document.createElement(tag); if (className) node.className = className; return node; };
    const text = (node, value) => { node.textContent = String(value ?? ""); return node; };
    const initials = (name) => Array.from(name || "?").slice(0, 2).join("").toUpperCase();
    function render() {
      const vm = state.viewModel;
      const members = vm.members || [];
      if (!members.some((member) => member.memberId === selectedMemberId)) selectedMemberId = members[0]?.memberId ?? null;
      text(document.getElementById("team-title"), "CFLS · " + (state.teamName || vm.teamId || "Team"));
      text(document.getElementById("team-subtitle"), vm.statusText || "Waiting for coordination data");
      const stateNode = document.getElementById("connection-state");
      stateNode.className = "state" + (vm.offline ? " offline" : vm.stale ? " stale" : "");
      text(stateNode, vm.offline ? "Offline" : vm.stale ? "Stale" : "Live");
      const list = document.getElementById("member-list"); list.replaceChildren();
      if (members.length === 0) { list.append(text(el("div", "empty"), "No team members are currently visible.")); }
      for (const member of members) {
        const button = el("button", "member" + (member.memberId === selectedMemberId ? " selected" : "")); button.type = "button";
        button.addEventListener("click", () => { selectedMemberId = member.memberId; render(); vscode?.setState({ selectedMemberId }); });
        const avatar = text(el("span", "avatar"), initials(member.memberId));
        const copy = el("span"); copy.style.minWidth = "0";
        copy.append(text(el("div", "member-name"), member.memberId));
        const activity = member.activityKnown ? member.files.length + " active file" + (member.files.length === 1 ? "" : "s") : "No activity reported";
        copy.append(text(el("div", "member-meta"), (connectionLabel[member.connectionState] || "Roster pending") + " · " + activity));
        button.append(avatar, copy); list.append(button);
      }
      const detail = document.getElementById("member-detail"); detail.replaceChildren();
      const member = members.find((item) => item.memberId === selectedMemberId);
      if (!member) { detail.append(text(el("div", "empty"), "Live roster members and their activity appear here in real time.")); return; }
      detail.append(text(el("h2"), member.memberId));
      const devices = member.activityKnown ? (member.deviceIds.length ? member.deviceIds.join(", ") : "No device id reported") : "No activity metadata reported";
      const revision = member.lastEventRevision === null ? "No activity revision" : "Active entry revision " + member.lastEventRevision;
      detail.append(text(el("div", "subtle"), "Connection: " + (connectionLabel[member.connectionState] || "Roster pending") + " · Active devices: " + devices + " · " + revision));
      const tasks = el("div", "section"); tasks.append(text(el("h3"), "Declared work"));
      if (!member.tasks.length) tasks.append(text(el("div", "empty"), member.activityKnown ? "No explicit task declared. Active files are shown below." : "This teammate is in the live roster but has not reported active work."));
      for (const task of member.tasks) { const card = el("article", "card"); card.append(text(el("div", "card-title"), task.description || "Undescribed coordination task")); const body = el("div", "card-body"); const paths = [...task.modifyPaths.map((path) => "Modify: " + path), ...task.createPaths.map((path) => "Create: " + path)]; text(body, paths.length ? paths.join("\n") : "No paths recorded."); card.append(body); tasks.append(card); }
      detail.append(tasks);
      const files = el("div", "section"); files.append(text(el("h3"), "Current files"));
      if (!member.files.length) files.append(text(el("div", "empty"), member.activityKnown ? "No active files." : "No activity metadata reported yet."));
      for (const file of member.files) { const row = el("div", "file-row"); row.append(text(el("code"), file.path)); const roles = el("div", "roles"); for (const role of file.roles) roles.append(text(el("span", "tag"), roleLabel[role] || role)); row.append(roles); files.append(row); }
      detail.append(files);
      const diff = el("div", "section");
      const isLocalMember = member.memberId === state.selfMemberId;
      diff.append(text(el("h3"), isLocalMember ? "Your local diff preview" : "Teammate diff preview"));
      if (!isLocalMember) {
        const paths = member.files.map((file) => file.path).slice(0, 3);
        const pathText = paths.length ? " Current activity: " + paths.join(", ") + "." : "";
        diff.append(text(el("div", "privacy"), "CFLS never uploads or relays teammate source patches." + pathText + " Ask this teammate to open their own CFLS panel to view their local preview."));
      } else if (!state.localDiffPreview) {
        diff.append(text(el("div", "empty"), "Open a locally changed, unsaved file to show a small diff here. This preview remains only on this computer."));
      } else {
        const preview = state.localDiffPreview;
        const card = el("div", "diff-card");
        const meta = preview.changedLines + " changed line" + (preview.changedLines === 1 ? "" : "s") + (preview.truncated ? " · preview limited" : "") + " · source stays local";
        card.append(text(el("div", "card-title"), preview.path));
        card.append(text(el("div", "diff-meta"), meta));
        const pre = el("pre", "diff-preview");
        for (const line of preview.lines) {
          const row = el("div", "diff-line " + line.kind);
          row.append(text(el("span", "diff-prefix"), diffPrefix[line.kind] || " "));
          row.append(text(el("span"), line.text));
          pre.append(row);
        }
        card.append(pre); diff.append(card);
      }
      detail.append(diff);
    }
    const restored = vscode?.getState(); if (restored?.selectedMemberId) selectedMemberId = restored.selectedMemberId;
    window.addEventListener("message", (event) => { if (event.data?.type === "team-state") { state = event.data.state; render(); } });
    render();
  </script>
</body>
</html>`;
}
