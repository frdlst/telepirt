/**
 * rc - `/rc <host>` serves Pi's built-in tools on a remote host as an MCP server over ssh.
 *
 * Copies ../server.mjs and the local Pi's self-contained dist/bundle to ~/.pi/telepirt/<key> on
 * the host and registers `ssh host node .../server.mjs` with codemode exposure, so no tools are
 * added to the model's toolset. Scripts call them as `tools.mcp__<host>__edit({...})`.
 * The host only needs Node.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";

// Same multiplexing options as the ssh tool (ssh.ts).
const OPTS = [
	"-o", "ControlMaster=auto",
	"-o", "ControlPath=~/.ssh/pi-%C",
	"-o", "ControlPersist=10m",
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
];
const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

// Runs on the remote as `node -` (script on stdin), so it works the same under cmd.exe, PowerShell
// and sh: no shell detection or quoting. Creates the target dir and reports whether it is complete.
const probe = (key: string) => `
const fs = require("fs"), path = require("path"), os = require("os");
const dir = path.join(os.homedir(), ".pi", "telepirt", ${JSON.stringify(key)});
fs.mkdirSync(dir, { recursive: true });
const server = path.join(dir, "server.mjs");
console.log(JSON.stringify({ server, ready: fs.existsSync(server), platform: process.platform, version: process.version }));
`;

// POSIX single-quoting: close the quote, add an escaped quote, reopen.
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function run(cmd: string, args: string[], input = "") {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d));
		p.stderr.on("data", (d) => (stderr += d));
		p.on("error", reject);
		p.on("close", (code) => resolve({ code, stdout, stderr }));
		p.stdin.end(input);
	});
}

export default function rcExtension(pi: ExtensionAPI) {
	// shortcut: registrations are per session; run /rc again after /reload or restart. Upgrade: re-register on session_start from a settings key.
	pi.registerCommand("rc", {
		description: "Serve Pi's built-in tools on an SSH host to codemode as mcp__<host>",
		handler: async (args, ctx) => {
			const host = args.trim();
			if (!host) return ctx.ui.notify("Usage: /rc <host | user@host | ssh alias>", "warning");
			// MCP server names allow letters, digits, _ and -.
			const name = host.replace(/^.*@/, "").replace(/[^A-Za-z0-9_-]/g, "_");

			const bundle = join(getPackageDir(), "dist", "bundle");
			if (!existsSync(join(bundle, "index.js")))
				return ctx.ui.notify(`No Pi bundle at ${bundle}; /rc needs a Node-based Pi install`, "error");
			// A new Pi version or server.mjs gets a fresh remote dir.
			// shortcut: old dirs under ~/.pi/telepirt stay on the remote, delete them by hand.
			const key = `${VERSION}-${createHash("sha256").update(readFileSync(SERVER)).digest("hex").slice(0, 12)}`;

			const res = await run("ssh", [...OPTS, "--", host, "node -"], probe(key));
			if (res.code === 255) return ctx.ui.notify(res.stderr.trim() || `ssh to ${host} failed`, "error");
			let remote: { server: string; ready: boolean; platform: string; version: string };
			try {
				remote = JSON.parse(res.stdout.trim().split("\n").pop() ?? "");
			} catch {
				return ctx.ui.notify(`Node not usable on ${host} (install Node first): ${res.stderr.trim() || res.stdout.trim()}`, "error");
			}

			if (!remote.ready) {
				ctx.ui.notify(`Copying Pi ${VERSION} tools to ${host}...`, "info");
				// Relative scp paths resolve against the remote home on POSIX and Windows OpenSSH alike.
				// server.mjs goes last, so `ready` means the bundle copy finished.
				const dest = `${host}:.pi/telepirt/${key}/`;
				const cp = await run("scp", ["-q", "-r", ...OPTS, "--", bundle, SERVER, dest]);
				if (cp.code !== 0) return ctx.ui.notify(`scp to ${host} failed: ${cp.stderr.trim()}`, "error");
			}

			const server = remote.platform === "win32" ? `"${remote.server}"` : q(remote.server);
			pi.registerMcpServer(name, {
				command: "ssh",
				args: [...OPTS, "--", host, `node ${server}`],
				exposure: "codemode",
				description: `Pi built-in tools running on ${host}`,
			});
			// Pi downloads rg/fd for linux, darwin and win32 only.
			const hint = remote.platform === "freebsd" ? ". grep/find need rg and fd: pkg install ripgrep fd-find" : "";
			ctx.ui.notify(`mcp__${name}: Pi tools on ${host} (${remote.platform}, Node ${remote.version})${hint}`, "info");
		},
	});
}
