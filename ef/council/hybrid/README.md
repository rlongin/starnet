# EF Agent Council Genesis — PC-first model routing

Status: implemented and tested locally with mock models and the real StarNet runtime. Not deployed. No host, DNS, paid provider, live account, Windows startup task, or desktop configuration has been changed.

## What runs where

One dedicated cloud station remains online and owns its agents, task execution, files, history, and schedules. Its **Custom OpenAI-Compatible** provider calls this router. An outbound Windows bridge offers the already-installed local Ollama model when available. When there is no idle bridge, or the local model fails/times out, the router calls one configured cloud model if explicitly enabled. A returning PC becomes eligible for the next model request. Busy PCs also use cloud fallback; this is not exclusively a power-state check.

This is model failover, **not two copies of StarNet synchronized between machines**. The PC supplies inference only. Tools execute on the dedicated cloud station, not on the PC. Local desktop files, browser logins, native desktop controls, agents, and existing Monday schedule are not automatically copied. The current desktop installation can continue independently. Do not recreate its Monday job in the cloud until the old schedule is deliberately retired, or both may run.

The original station renderer is unchanged; Nexus remains its sign-in wrapper. The artwork/license and isolated-host requirements in `../README.md` still apply. This pilot is for Ric's private station. Do not share one bridge/credential between members' private stations. A shared council requires its own deliberately authorized setup.

## Recovery behavior

The bridge only performs `/api/tags` and `/v1/chat/completions` against loopback Ollama. It neither starts Ollama, pulls models, executes tool calls, nor opens a listening port. It sends HTTPS requests to a dedicated cloud bridge origin; it needs no inbound tunnel and does not touch the existing Cloudflared/NexusRENN/LiteLLM stack.

The router requests non-streamed completions from each backend, bounds their size, and selects one complete response before forwarding content/tool calls to StarNet. Streaming clients get SSE keepalive comments while waiting, then the completed response as SSE. **Live token-by-token display is not supported in this first version.** A failed, incomplete, late or cancelled local reply cannot overwrite the selected cloud reply. No StarNet task or external tool action is automatically replayed by this router. A local model may continue computing briefly after cancellation, bounded by its timeout; it never executes returned tool calls.

An active model request is ephemeral. A router/cloud-station crash can fail that request; this is not durable task recovery and does not provide an exactly-once guarantee for StarNet's own tools/retry policies. Existing StarNet task/scheduler recovery remains responsible for interrupted tasks. There is no offline local station control when the cloud host is down.

## Deployment package

Prerequisite: Node 22+ on a dedicated isolated station VM and the Windows PC. Use separate unprivileged users for StarNet, its sign-in gateway, and this router. Keep all router code/config root-owned, not writable or readable as appropriate by station tools. Keep the original station workspace on a backed-up persistent disk. No host admin credentials or shared Docker socket in the station environment.

1. Configure the original station and Nexus gateway using `../README.md`. Provision the original station as an unattended service on the cloud VM; this package does not install it or migrate a desktop save. The original station's service and workspace must survive reboot. Resolve original asset rights before the member rollout.
2. Put a private copy of `router.env.example` at `/etc/ef-council/router.env`, owned by root with restrictive permissions. Generate distinct random 32-byte base64url station and bridge keys. Replace the public HTTPS bridge origin. Select a provider and model supporting Chat Completions and function calls, set its spending limit, and only then set `HYBRID_CLOUD_ENABLED=true`. No cloud provider or model is silently chosen.
3. Install `ef-council-router.service` for a separately created `ef-council-router` OS user. Its paths assume this repository is installed read-only under `/opt/starnet` and Node is `/usr/bin/node`; adapt to the actual host. Enable this service at boot using the host's service manager. The router listens only on `127.0.0.1:8899`.
4. Configure a dedicated HTTPS hostname using the Caddy example (or equivalent). Publish **only `/worker/*`**, preserve the public Host, and keep `/v1/*` and `/status` private. Never expose ports 8787/8898/8899 directly. Set host firewalls and metadata/private-network restrictions according to the station isolation requirements. Validate Caddy/systemd configuration on the actual host before enabling; these templates have not been exercised on a provisioned VM.
5. In the **cloud station's** original provider settings, add Custom OpenAI-Compatible: base URL `http://127.0.0.1:8899/v1`, API key equal to `HYBRID_STATION_KEY`, model `ef-hybrid`. The existing source also supports `CUSTOM_OPENAI_BASE_URL` and `CUSTOM_OPENAI_KEY` as environment configuration. Configure the station's agents/tasks to use that provider. Do not change the desktop provider.
6. On the PC, put a private copy of `bridge.env.example` outside the repository, with the bridge origin/key and existing local model. Keep it under the Windows user's private profile and restrict its ACL. From this directory, test with `node --env-file="C:\path\bridge.env" pc-bridge.cjs`. It will wait if the configured model is missing or Ollama is unavailable; it never installs or starts either.
7. After the manual bridge test, install login startup with `node install-windows-bridge.cjs --config "C:\path\bridge.env"`. The installer creates only the named `EF Council PC Bridge` Task Scheduler task, under the current user's limited interactive account. It does not start the task immediately or restart any existing application. Launch it through Task Scheduler after checking the configuration. Startup means **after Windows login**, not pre-login boot; cloud fallback handles the interval before login and sleep/offline periods. Windows Task Scheduler execution remains untested in this Linux workspace.

## Limits and validation

- Server-only cloud credentials never reach the PC. The station key cannot claim bridge work; the bridge key cannot call the model API. Bridge access is private station access: it can see prompts/tool results and supply model replies. Revoke a lost bridge key by rotating it and restarting only this dedicated router/bridge.
- Cloud fallback can send conversation contents and tool results to the chosen provider. Configure it only for the intended private station and provider agreement. Context and tool capabilities must fit **both** models. The default advertised context is 8192; verify the actual Ollama runtime context and cloud model before raising it.
- Bounded output (default 2048 tokens), at most two concurrent model requests, and explicit cloud opt-in are provided. These are **not a dollar budget**. Configure billing controls at the provider. Pricing remains unpriced rather than falsely reporting zero cost. Test model-specific parameters; not all OpenAI-compatible providers support every parameter.
- Status is available through authenticated loopback `GET /status`: local ready/busy, cloud enabled, active requests and per-process completion/failure counters. No prompts or keys are logged. Counters reset on restart; they are not billing records.
- `node --test ef/council/test/*.test.cjs` covers routing and the real original station's 268 renderer dependencies, API guards, local/cloud completions, and persisted task histories. Models are HTTP fixtures; no paid calls or real Windows/Ollama/cloud-host test is claimed.
- Before live acceptance: verify TLS, real local and cloud tool calling, capacity/cost behavior, PC asleep/off/on/login, cloud VM reboot, station backup restore, the hosted browser, and exactly one scheduled Monday job in `America/Los_Angeles`. The scheduling test is still outstanding; no existing schedule was changed.

Rollback: select the prior provider in the cloud station, disable the dedicated router service and its bridge hostname, and run `node install-windows-bridge.cjs --remove` on Windows to stop/remove only this bridge task. Preserve the cloud station workspace. The original desktop remains independent.

Protocol references: https://docs.ollama.com/api/openai-compatibility and https://nodejs.org/api/http.html. The native StarNet provider adapter is `sidecar/providers/openai-compatible.js`.
