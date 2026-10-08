# StarNet / Nexus known-good restore package

This package restores the PC-facing pieces to the last known-good settings instead of chasing the current broken state.

Pinned restore points:

- StarNet Council: `rlongin/starnet` branch `backup/council-station-working-20260928`, commit `24cf4da4f2e0e5a9374797bed17f087401859ed7`.
- Nexus ReNN / Lovable platform source: `rlongin/efv-nexus-hub` branch `backup/nexusrenn-golden-2026-09-24`, commit `390449bc1decc21c1c3334c44c0271437d9f071f`.
- Codex chat/repair model: `gpt-5.5` with `approval_policy = "on-request"` and `sandbox_mode = "workspace-write"`.
- Local LLM runtime: `qwen3:8b` through loopback Ollama, preferring port `11434` and accepting the existing recovery port `11435` when that is where the model is reachable.
- Nexus ReNN local gateway: `http://127.0.0.1:4000/v1/chat/completions`, model route `nexus-primary`, display/model name `Laleau`.
- EF Council ports: preserved known-good station `8798`, gateway `8799`, member stations starting at `8801`.

Run audit-only first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ef\restore-known-good\Restore-StarNetKnownGood.ps1
```

Apply restore:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ef\restore-known-good\Restore-StarNetKnownGood.ps1 -Apply
```

What `-Apply` does:

1. Backs up Codex config and writes a GPT-5.5/on-request/workspace-write config.
2. Creates `C:\NexusAI\KnownGoodRestore\START-STARNET-CODEX-GPT55.cmd` for local ChatGPT/Codex work on the StarNet repo.
3. Stashes uncommitted repo changes, then checks out local restore branches pinned to the known-good commits.
4. Writes `known-good-runtime.env` with the Council/Nexus ReNN local model settings.
5. Registers a current-user Windows startup task named `EF StarNet KnownGood Supervisor` that checks health after login, starts Ollama if the configured loopback port is down, and restarts only the known gateway pieces when they are missing.
6. Runs verification against Codex CLI, Ollama, Nexus ReNN gateway, Council `8798`, and Council gateway `8799`.

It does not erase workspace data, regenerate encrypted launch keys, disable Bitdefender, change production Lovable publishing, or stop the preserved `8798` Council station. If Bitdefender blocks a launch, add a narrow allow rule for the exact `node.exe`, `ollama.exe`, or `codex.exe` path shown in the restore log rather than disabling protection or excluding whole folders.

