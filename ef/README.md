# EF Agent Studio — local preview

An independent EF Ventures interface using StarNet's existing agent runtime. Working name: **EF Agent Studio**. This is an early test interface, not a complete recreation of StarNet's visual station, team-building UI, desktop shell, or integrations.

## Start on your own computer

Requires Git and Node.js 22 or newer. In a terminal:

```sh
git clone --branch ef/agent-studio-preview --single-branch https://github.com/rlongin/starnet.git
cd starnet
npm ci --prefix ef
npm start --prefix ef
```

Open **http://127.0.0.1:8797/ef/**. The large upstream repository may take time to clone.

The page supports OpenRouter (bring your own API key) or an already-running Ollama instance. Enter a valid model ID from the selected provider. The connection check verifies provider access; it does not prove that a particular model will run. Entering a key does not save it. The key remains in the tab's memory and travels to the local runtime over loopback for validation and requests. The upstream runtime uses it to contact the selected provider. Live provider testing has not been performed for this preview.

## What can be tested

- Original EF interface and responsive desktop/tablet/mobile presentation.
- Task starters, a single-agent task brief, and selection of any agents already present in this isolated runtime's roster.
- Optional web/files/memory capability selection, with upstream runtime permission checks retained.
- Streamed responses; explicit success, failure, interruption and budget outcomes.
- Permission approval **once**, denial, and replies to agent clarification questions.
- Stop request by closing the active response stream; persisted history provides the final outcome.
- Download the current response as Markdown; read recent runtime run history.

The preview does not yet expose crew creation, visual station building, remote member login, scheduled work, voice, native terminals, or desktop installers. Native `node-pty` is intentionally not installed by this lightweight launcher; its optional-module warning is expected. No claim of complete upstream feature parity is made.

## Separate workspace

The launcher uses port **8797** and `~/.ef-agent-studio/workspaces`, not an existing StarNet workspace. It strips inherited `STARNET_*`/`SKYNET_*` settings, disables startup import of legacy station roots in EF mode, and does not enable upstream cloud accounts, unattended jobs, or external-harness access. It does not configure/restart Ollama, Docker, Cloudflared, or NexusRENN.

Optional overrides: `EF_STUDIO_PORT` (1024–65535) and `EF_STUDIO_DATA` (use a dedicated folder). Do not point this at an existing production station. Stop this preview with Ctrl+C in its terminal.

## Nexus test page versus connected app

The four files in `frontend/ef/` also form a **design-only preview** when served without the sidecar's launch token. This mode makes no runtime API calls and disables execution, provider checking, and API-key entry. It does not invent agents, work, spend, or history. For another path, change the HTML `<base href="/ef/">` to the public preview directory.

Nexus's standalone preview path is `/previews/agent-studio/index.html`. It is for visual review only until a separate runtime has been hosted and authenticated. A browser on Nexus must not be pointed at a shared privileged loopback service. Production member access requires server-side identity checks and isolated per-member workspaces/secrets before any Experience tile is approved.

## Validation

```sh
npm test --prefix ef
```

The tests start the real backend in a temporary workspace and use a **local mock model provider**. They verify asset serving, blocked upstream artwork paths, token/host/origin checks, provider credential validation, successful and failed streamed runs, and persisted run history. They also exercise fragmented NDJSON events and honest failure labels. No paid provider calls are made by these tests.

Manual acceptance still required: live provider response; permission prompts in browser; desktop/tablet/phone visual review; response download; stop behavior with a live provider; reload history. Hosted authentication and member isolation are not implemented.

## Attribution and distribution

Upstream: https://github.com/androoAGI/starnet at `7ee93ceac14c6bcb500ab263e92186e3a2d8b5d7`. Preserve root `LICENSE` and `NOTICE.md`. The original StarNet name, logo, station artwork, sprites and brand identity are excluded from its MIT code grant according to upstream's notices. The EF interface uses original HTML/CSS and system fonts; EF mode serves only its four UI files. Upstream artwork remains in fork history but is not used by this preview. Do not ship upstream artwork or desktop packages as EF products.

The preview's visual identity does not imply endorsement by StarNet or its author. No Experience tile should be created until Ric tests and approves the app.

## Rollback and upstream updates

The fork's default branch remains unchanged. All preview work is on `ef/agent-studio-preview`. Run the original checkout on its default branch for upstream behavior; no database migrations are required. Review upstream updates on a branch and rerun EF and affected upstream tests before merging. Keep EF workspace data separate when testing another version.
