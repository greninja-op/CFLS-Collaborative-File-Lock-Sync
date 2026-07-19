# CFLS landing page

A single, self-contained static landing/demo page for CFLS — built for the
hackathon submission. No build step, no framework install: just HTML + Tailwind
(CDN) + GSAP (CDN) + a little vanilla JS.

```
website/
├─ index.html   # the page (all sections)
├─ styles.css   # custom styling + the editor/terminal mockups
├─ main.js      # scroll reveals, tabs, copy buttons, hero + demo animations
├─ vercel.json  # zero-config static deploy for Vercel
└─ README.md
```

## Preview locally

Just open `index.html` in a browser. For a proper local server (so clipboard
copy works in all browsers):

```
npx serve website
# or
python -m http.server 5173 --directory website
```

## Deploy — pick one (both are free)

### Vercel
1. Push this repo to GitHub (already done).
2. On vercel.com → **New Project** → import the repo.
3. Set **Root Directory** to `website`. Framework preset: **Other**. No build
   command, output dir = `.` (the included `vercel.json` already declares this).
4. Deploy → you get a `*.vercel.app` URL. Put that URL in your Devpost submission.

### GitHub Pages
1. Repo → **Settings → Pages**.
2. Source: **Deploy from a branch** → branch `main`, folder `/website` isn't a
   Pages option directly, so either:
   - move/copy these files to a `/docs` folder and select `/docs`, **or**
   - use the "GitHub Actions → Static HTML" workflow and set the path to `website`.
3. Save → your page publishes at `https://<user>.github.io/<repo>/`.

> Update the download links: the two cards in the **Install** section point to
> `…/releases`. Publish `cfls.exe` + `cfls-coordination.vsix` as a GitHub Release
> and they'll resolve.

## The demo video (for Devpost)

The page already has an **animated in-page demo** (the Alice/Bob split-screen),
so the site looks alive without any recording. For the Devpost **video**, here's
the honest, best-quality path:

**Record the real thing (recommended).** A genuine screen capture of your tool
beats any generated footage and is what judges trust.
1. Run `pnpm playground` to start a host + 3 agents.
2. Open two editor windows (Alice, Bob) side by side.
3. Record your screen — free options:
   - **Windows Game Bar**: press `Win + Alt + R` to start/stop (built into Windows).
   - **OBS Studio** (free): more control, webcam overlay, scene switching.
4. Show: both online → Alice edits a shared file → Bob's status bar/lock reacts →
   (optional) auto-sync notice. 45–90 seconds is ideal.

**Where AI genuinely helps** (without faking your UI):
- **Voiceover/narration** — write a short script, generate a natural voice with a
  free AI TTS (e.g. ElevenLabs free tier) and lay it over the recording.
- **Auto-captions & quick edits** — CapCut (free) or Descript auto-caption and let
  you trim by editing the transcript.
- **Intro/outro polish** — a short AI-generated title card is fine.

**Avoid** pure text-to-video generators (Sora / Runway / Pika) to depict the
actual product — they'll invent a fake UI that isn't your tool, which misleads
judges and can hurt credibility. Use real footage for anything showing CFLS
working; reserve generative video (if any) for decorative intro shots only.

Suggested 60–90s script beats: problem (agents collide) → what CFLS is →
live demo (presence + lock + warning) → one line on auto-sync + security →
"free, open source, install in one command."
