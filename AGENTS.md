# telepirt

Pi package. No build step, no runtime dependencies.

- `extensions/ssh.ts`: `ssh` tool. `extensions/rc.ts`: `rc` tool and `/rc` command, both bootstrap a host and register the MCP server.
- `server.mjs`: runs on the remote. It imports `./bundle/index.js`, Pi's own `dist/bundle` copied next to it. Keep it plain JS with no imports beyond `node:*` and the bundle.
- Pi docs: `extensions.md`, `mcp.md`, `packages.md` in the Pi install's `docs/`.

Rules:
- Wrap Pi's tool factories. Don't reimplement tool logic.
- server.mjs stdout carries the protocol only. Log to stderr.
- Remote commands must work under cmd.exe, PowerShell and sh. Prefer `node -` with a script on stdin over shell quoting.
- Don't add model-facing tools beyond `ssh` and `rc`. Remote tools stay codemode-only.

Test: `node test.mjs` (runs server.mjs locally against the installed Pi). Test hosts: `Administrator@devtest` (Windows).
