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

Open **http://127.0.0.1:8797/** for the original StarNet station, or **http://127.0.0.1:8797/ef/** for the EF task page. The large upstream repository may take time to clone.

The page supports OpenRouter (bring your own API key) or an already-running Ollama instance. Enter a valid model ID from the selected provider. The connection check verifies provider access; it does not prove that a particular model will run. Entering a key does not save it. The key remains in the tab's memory and travels to the local runtime over loopback for validation and requests. The upstream runtime uses it to contact the selected provider. Live provider testing has not been performed for this preview.

## Automatic Windows startup

On the Windows machine, open a terminal in the checkout that actually serves EF Studio and run:

```powershell
node .\ef\install-windows-startup.cjs
```

This installs and reads back an **EF Agent Studio** shortcut in the current user's Windows Startup folder. It launches quietly when that user signs in, including after a restart. Administrator access is not required and no execution-policy setting is changed. This is sign-in startup, not a system service that runs before login.

The shortcut pins the Node executable and repository paths used during installation. Keep this checkout at the same path; rerun the installer after moving it or changing the Node installation. Ric's confirmed working checkout is `C:\Users\Ricardo\Documents\GitHub\starnet`.

The installer also requests a background launch immediately. If port 8797 is already occupied, it leaves the existing process alone instead of starting a second copy. It never stops an existing process or configures Ollama, Docker, Cloudflared, or NexusRENN. Ollama still needs to be available through its existing startup setup when a local-model task is run.

Open **http://127.0.0.1:8797/** for the original station or **http://127.0.0.1:8797/ef/** for the EF task page. Logs go to `%USERPROFILE%\.ef-agent-studio\logs\startup.log` by default. The background process does not require a terminal to remain open. A manually launched process that already occupies the port is not converted into a background process; the shortcut takes effect on the next sign-in.

To remove only the managed startup shortcut:

```powershell
node .\ef\install-windows-startup.cjs --remove
```

Removal leaves current processes and workspace data intact. An unrelated shortcut with the same filename is never overwritten or deleted.

Validation: six Node tests cover duplicate prevention, a real background child launch, real TCP listener detection, invalid-port rejection, shortcut argument encoding, and scoped removal. Windows shortcut creation and restart/sign-in acceptance must be verified on the Windows machine; these Node tests do not claim Windows end-to-end coverage.

## Original StarNet visual station

The local launcher now preserves the original StarNet station at **http://127.0.0.1:8797/**. It serves the existing upstream HTML, styles, scripts, fonts and sprites without redesigning them. The EF task page remains at `/ef/`; both pages use the same runtime and isolated workspace. First-time station onboarding may still be needed because the earlier EF task page did not create a visual station save.

After pulling this change, stop the manually running EF process with Ctrl+C in its terminal, then run the startup installer above. If it says the port is occupied, it has left the old process alone: the new view will become available when the updated launcher runs after your next Windows sign-in. The startup shortcut launches the runtime; open the station URL in your browser when you want the visual.

The launcher enables `STARNET_EF_ORIGINAL_UI=1` while keeping `STARNET_EF_STUDIO=1`, workspace isolation, host/token checks and cloud restrictions. Set `EF_STUDIO_ORIGINAL_UI=0` before launching to return to the branded-only view. Direct EF-mode sidecar launches without the original-UI flag still serve only the four EF files.

This is the original browser-rendered station, not the native desktop shell. Native terminal functionality still requires the optional `node-pty` dependency. For the packaged desktop product, use the original [StarNet desktop release](https://github.com/androoAGI/starnet-releases/releases/latest). Preserve upstream branding and notices: the upstream README excludes the StarNet name, logos, station artwork and sprites from the MIT code grant; enabling this local view does not grant redistribution rights for an EF-branded product.

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

Nexus's standalone preview path is `/previews/agent-studio`: [open the design preview](https://preview--longasto.lovable.app/previews/agent-studio). It is for visual review only until a separate runtime has been hosted and authenticated. A browser on Nexus must not be pointed at a shared privileged loopback service. Production member access requires server-side identity checks and isolated per-member workspaces/secrets before any Experience tile is approved.

## Validation

```sh
npm test --prefix ef
```

The tests start the real backend in a temporary workspace and use a **local mock model provider**. They verify asset serving, blocked upstream artwork paths in branded-only mode, token/host/origin checks, provider credential validation, successful and failed streamed runs, and persisted run history. The original-station test runs the real local launcher, checks unchanged station HTML and all 268 linked dependencies, confirms that both views receive the same runtime token, and checks host/API restrictions. They also exercise fragmented NDJSON events and honest failure labels. No paid provider calls are made by these tests.

All 16 Node tests passed for the original-station change. The remote browser could not access the loopback test server, so visual rendering and Windows restart/sign-in acceptance still require a check on the Windows machine.

Hosted desktop browser check passed at 1363 px: page rendered, no horizontal overflow, task starter populated the brief, and execution/provider/key controls remained disabled in design mode. Tablet/phone visual checks remain outstanding.

Manual acceptance still required: live provider response; permission prompts in browser; desktop/tablet/phone visual review; response download; stop behavior with a live provider; reload history. Hosted authentication and member isolation are not implemented.

## Attribution and distribution

Upstream: https://github.com/androoAGI/starnet at `7ee93ceac14c6bcb500ab263e92186e3a2d8b5d7`. Preserve root `LICENSE` and `NOTICE.md`. The original StarNet name, logo, station artwork, sprites and brand identity are excluded from its MIT code grant according to upstream's notices. The EF interface uses original HTML/CSS and system fonts. Branded-only EF mode serves its four UI files; the local launcher additionally exposes the original StarNet view with its existing branding. Do not ship upstream artwork or desktop packages as EF products.

The preview's visual identity does not imply endorsement by StarNet or its author. No Experience tile should be created until Ric tests and approves the app.

## Rollback and upstream updates

The fork's default branch remains unchanged. All preview work is on `ef/agent-studio-preview`. Run the original checkout on its default branch for upstream behavior; no database migrations are required. Review upstream updates on a branch and rerun EF and affected upstream tests before merging. Keep EF workspace data separate when testing another version.
