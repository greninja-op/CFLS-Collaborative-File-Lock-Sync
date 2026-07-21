# CFLS website

This is the static product site for Collaborative File Lock Sync (CFLS). It has
no build step and intentionally does not depend on a framework: index.html,
styles.css, and main.js are the complete site.

## Run it locally

Open index.html directly for a quick check, or use a local server:

    python -m http.server 4173 --directory website

Then visit http://127.0.0.1:4173.

## What the page communicates

The page is arranged as a product story, not a generic feature list:

1. Hero: two separate editor workspaces connected through the Coordination Host.
2. Before/after: the collision is prevented before the Git merge stage.
3. Architecture: editor -> local CFLS Agent -> shared Host, while Git keeps
   moving actual source code.
4. Interactive walkthrough: Alice edits, the Host receives coordination
   metadata, Bob sees context, and chooses a safe next action.
5. Product status: what is usable in the MVP versus what is still being
   hardened.
6. Role-based setup: playground, Host admin, teammate, VS Code/Kiro, and
   source build paths.
7. FAQ: Git, privacy, Host placement, and MVP status.

The visual system is deliberate:

- Graphite and dark-teal surfaces make it feel like a coordination console.
- Signal green means safe/active; cyan means metadata transport; amber means
  coordinate; red means a collision risk.
- Manrope is the product typeface; JetBrains Mono is used only for code,
  commands, and system labels.
- All illustrations are CSS/HTML product diagrams, not AI-generated screens.

## Real demo video

The page currently has an accessible, interactive product walkthrough rather
than pretending an unrecorded mockup is a real video. The real demo should be a
45-90 second screen recording of the local playground:

    pnpm playground

Record two separate VS Code windows as two simulated teammate environments:

1. Alice opens and edits payments.ts.
2. Alice's CFLS status becomes active.
3. Bob sees that one file is in play.
4. Bob runs CFLS: Show Coordination Status.
5. Bob switches to a safe next task or coordinates with Alice.
6. Close on the fact that Git remains responsible for source code.

Use real product footage, captions, and a short transcript when the recording is
ready. Do not use a text-to-video model to fabricate the editor UI.

## Content accuracy rules

The marketing copy deliberately distinguishes current MVP behavior from planned
hardening:

- Supported editor paths: VS Code and Kiro through the packaged .vsix.
- The local Agent can run directly with `cfls agent` or as a per-user service:
  `systemd --user` on Linux and Task Scheduler on Windows.
- Soft coordination signals and the clickable active-team panel are demoable
  now. Do not promise operating-system-level hard edit blocking as a finished
  feature.
- Local dependency analysis and the authenticated 13-tool MCP bridge are part
  of the current MVP. Broader coding-agent integrations remain future work.
- Source code remains in Git. CFLS is designed to share coordination metadata;
  local dependency analysis may read source files locally to derive metadata.
- The standalone cfls.exe must be shipped through a GitHub Release or internal
  distribution. It is intentionally not part of the static website repository.

## Deploy

The included vercel.json serves this folder as a static site. In Vercel:

1. Import the repository.
2. Set **Root Directory** to website.
3. Use the **Other** framework preset.
4. Use no build command and deploy.

Before publishing, replace any development/repository links with final release
asset URLs and add a real Open Graph image if the public site URL is known.
