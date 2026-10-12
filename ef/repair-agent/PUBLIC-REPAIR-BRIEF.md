# Council repair background

This package contains candidate repairs for the Council gateway and Windows supervision, tested on Windows and Linux. It is not proof that an installed Council has been repaired.

The current installation is authoritative. Identify the active executable, script, configuration, member data and DPAPI account before changing files. A previous or newer installation can differ from this source revision. Preserve dirty repository work and existing encrypted credentials.

The candidate changes address:
- member runtimes discovering the host's legacy workspace;
- stale browser API tokens after member restart;
- crashed or hung member/gateway processes, including a gateway restart while a member is hung;
- Windows process ownership verification and startup task identity checks.

Use the installed local model and loopback endpoint. Do not silently substitute another model, port or paid provider. The local response verifier takes explicit station path, endpoint and model arguments. A passing HTTP health route is not model or tool acceptance.

The test suite exercises real sidecar persistence, backup/restore and tool writes with a controlled provider. Fixture keys and temporary data are used for gateway and Windows supervision tests. It does not verify a user's actual GPU, model, encrypted keys, launch issuer, original station, Bitdefender or long idle session.

If the owner supplies an earlier private repair handoff, read it locally and preserve its context. Never commit it or personal data to a public repository. Read LOCAL-MISSION.md and ACCEPTANCE.json before installing candidates.
