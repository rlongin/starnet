# EF Agent Council Genesis — station gateway pilot

This gateway adds Nexus sign-in in front of an **existing original StarNet station**. It does not substitute the simplified EF task page, copy artwork into Nexus, or connect to Ric's desktop installation. The Nexus wrapper carries the EF Agent Council Genesis name; the station's own original visuals and branding remain intact.

Status: development pilot, not deployed. No station hosts, domains, member assignments or real Supabase credentials have been provisioned. The gateway is not an OS sandbox and must never be used to put multiple private stations under one privileged OS account. Automated tests prove application-level routing boundaries, not host isolation or production readiness.

## Required deployment boundary

- One dedicated VM or equivalently isolated host per private station; one additional host for the shared council. Use a separate HTTPS hostname for each. Distinct folders or ports alone are insufficient: StarNet agents can run tools and commands.
- Run the gateway and station under separate unprivileged OS identities, with gateway source/configuration inaccessible to station tools. No shared writable volumes, home folders, credentials, Docker sockets or instance/host administration credentials.
- Keep the original sidecar bound to loopback. Permit public access only to a TLS reverse proxy forwarding to this gateway. Retain the configured public Host header; ignore forwarding headers supplied by the client.
- Restrict host/metadata/private-network access at the infrastructure boundary. Model services must be available through an explicitly authorized endpoint. This pilot does not expose or change Ric's Ollama, NexusRENN, Docker or Cloudflared setup.
- Private station: exactly one configured member UUID. Shared station: explicit allowlist; all assigned council members have access to that station's agents, files and conversations. Shared council access is not read-only and does not include private stations.
- The upstream NOTICE excludes StarNet branding/artwork/sprites from the MIT code grant. Obtain appropriate rights before deploying those assets to members, or supply cleared assets. These gateway changes grant no asset rights.

## Configuration

Each host needs Node 22+, an installed original StarNet runtime with its own workspace and a TLS reverse proxy. Configure the original runtime using its installation documentation; do not run the old simplified EF-only launcher. Its `STARNET_WORKSPACES` must belong solely to this station. No gateway setting migrates a desktop save or changes the runtime's permissions, schedules or providers.

Gateway environment example (replace all `.example.test` addresses and UUIDs):

```sh
COUNCIL_PUBLIC_ORIGIN=https://ric-station.example.test
COUNCIL_NEXUS_ORIGIN=https://nexus.example.test
COUNCIL_SUPABASE_ORIGIN=https://your-project.supabase.co
COUNCIL_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE
COUNCIL_MODE=private
COUNCIL_ALLOWED_USER_IDS=11111111-1111-4111-8111-111111111111
COUNCIL_WORKER_PORT=8787
COUNCIL_GATEWAY_PORT=8898
```

Supply environment through your host's service manager and run:

```sh
node ef/council/gateway.cjs
```

The gateway listens on **127.0.0.1:8898**, not all interfaces. Point the TLS proxy to that address. Do not publish port 8787. Create a persistent service for both runtime and gateway on the separate host; do not modify the working desktop's startup settings.

For a shared council, set `COUNCIL_MODE=shared` and a comma-separated explicit member UUID list. To revoke access, remove the member and restart only that station gateway; all its in-memory sessions/tickets are invalidated. Membership changes are manual in this pilot; there is no automatic provisioning or synchronisation with Nexus membership suspensions.

## Nexus integration

The companion Nexus branch adds `/platform/agent-council-genesis`. No Experience tile or existing Agent Council page is replaced. Configure **server-only** `NEXUS_COUNCIL_STATIONS` as a JSON array:

```json
[
  {"id":"ric-private","kind":"private","origin":"https://ric-station.example.test","memberIds":["11111111-1111-4111-8111-111111111111"]},
  {"id":"ef-council","kind":"shared","origin":"https://shared-station.example.test","memberIds":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"]}
]
```

The Nexus server authenticates the member using its existing auth middleware and returns only matching station entries, excluding other member IDs. The station gateway independently verifies the Nexus JWT through the configured Supabase Auth server and checks its own member allowlist. It does not trust a user ID, role, owner or origin sent in request JSON, or editable user metadata. No service-role key is needed and no database policies are changed.

Launch uses a 30-second single-use ticket posted as a form; credentials are not placed in launch URLs. The gateway issues a host-only Secure/HttpOnly session cookie, bounded by the authenticated JWT expiry and 15 minutes. The JWT is not retained or forwarded to StarNet. Upstream cookies and browser authorization headers are stripped. API writes require the exact station Origin before the gateway rewrites the loopback Origin for StarNet's unchanged guard. Every station asset/API request requires a gateway session; the original sidecar token is still required by StarNet.

The iframe is restricted to the configured Nexus parent. A separate-window launch is provided if third-party cookies are blocked. Prefer station hostnames under the same site as Nexus. Closing/leaving the Nexus test page requests gateway logout; if the browser drops that request, the session expires within 15 minutes. Supabase logout/deletion does not instantly revoke an already-issued gateway session. Restarting the gateway clears sessions. Reconnect from Nexus after expiry; do not assume long-running work remains controllable through an expired browser session. Server-side jobs continue according to the station's own settings.

## Validation and remaining gates

```sh
node --test ef/council/test/*.test.cjs
```

Tests cover real HTTP gateways, cross-member denial, cross-host ticket/cookie denial, single-use and expired tickets, session expiry/logout, credential stripping, Origin/Host checks and configuration validation. The original-station integration test checks the actual renderer, original linked assets, launch token and API access through the gateway without a paid model call. Nexus has separate directory tests.

Before a member pilot: provision isolated hosts; confirm asset rights; configure TLS, Supabase project and explicit test-member assignments; run the complete Nexus build in its checkout; visually test the original UI and a real task in the hosted browser; verify two real accounts cannot access one another's station; verify backup/restore and unattended scheduling on the chosen hosts. The remote browser cannot access this execution environment's loopback server, so no hosted visual acceptance is claimed.

Native desktop-only features remain native-only. HTTP and SSE streaming are proxied; WebSocket upgrades are explicitly rejected in this pilot. Check any terminal/voice/connector feature that needs them before enabling it. Runtime provisioning, billing/quotas and automatic membership lifecycle are not implemented.

Rollback: remove the Nexus test route and stop the dedicated gateway service. Existing desktop and Nexus production behavior are unchanged. Preserve station workspaces when retiring hosts.
