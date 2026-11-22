# telepirt

A Pi package that runs Pi's built-in tools on hosts you can reach over SSH.

- `ssh` tool: run a command on a remote host. Windows hosts get PowerShell (pwsh if found, else
  Windows PowerShell), others bash.
- `rc` tool and `/rc <host>` command: serve Pi's own `read`, `edit`, `write`, `ls`, `grep`, `find` and
  `bash`/`powershell` on the host as an MCP server named after it (`user@devtest` becomes
  `devtest`). The remote tools are not added to the model's toolset. Codemode scripts call them
  as `tools.mcp__devtest__edit({...})`. The model calls `rc` itself when a prompt names a host,
  so `/rc` is only needed to connect ahead of time.

Editing a Windows file with the real `edit` tool keeps its line endings and BOM, without the
model writing PowerShell to do it.

## Install

```bash
pi install /path/to/telepirt     # local checkout, loaded in place
pi install git:github.com/frdlst/telepirt
```

## Requirements

- Non-interactive SSH auth (keys or agent). Connections are multiplexed through
  `~/.ssh/pi-%C` sockets, kept 10 minutes after last use.
- Node on the remote's `PATH`. Nothing else is installed there.
- A Node-based local Pi install (managed installer or npm). `/rc` copies that Pi's
  `dist/bundle` to the remote, so remote tools always match the local Pi version.
- FreeBSD and other platforms Pi can't download `rg`/`fd` for: install them yourself
  (`pkg install ripgrep fd-find`).

## How `rc` works

1. `ssh host node -` runs a small probe script from stdin, which works under cmd.exe,
   PowerShell and sh alike. It reports the platform and whether
   `~/.pi/telepirt/<pi-version>-<server-hash>/` is already populated.
2. If not, `scp -r` copies Pi's `dist/bundle` and `server.mjs` there (about 3.5 MB, once per
   Pi version).
3. It registers `ssh host node ~/.pi/telepirt/<key>/server.mjs` as a stdio MCP server with
   `codemode` exposure. Check it with `/mcp`.

The server speaks newline-delimited JSON-RPC on stdin/stdout and runs tools in the remote
user's home directory. Cancelling a call aborts the remote command. Closing the connection
aborts everything still running.

## Limits

- Registrations last for the session. After `/reload` or a restart the model calls `rc` again.
- Old `~/.pi/telepirt/<key>` dirs stay on remotes after Pi updates.
- An aborted `ssh` tool call kills the local ssh only. The remote command keeps running.
- Pi's `powershell` tool skips Microsoft Store app aliases, so a Store-installed pwsh falls
  back to Windows PowerShell 5.1.

The remote server has the same rights as your SSH account and opens no ports.

## Test

```bash
npm test    # or: PI_PACKAGE_DIR=/path/to/pi-coding-agent node test.mjs
```
