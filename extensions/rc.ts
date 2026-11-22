/**
 * rc - the `rc` tool and `/rc <host>` command serve Pi's built-in tools on a remote host as an MCP server over ssh.
 *
 * Copies ../server.mjs and the local Pi's self-contained dist/bundle to ~/.pi/telepirt/<key> on
 * the host and registers `ssh host node .../server.mjs` with codemode exposure, so the remote tools
 * stay out of the model's toolset. Scripts call them as `tools.mcp__<host>__edit({...})`.
 * The host only needs Node.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

function run(cmd: string, args: string[], input = "", signal?: AbortSignal) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], signal });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d));
		p.stderr.on("data", (d) => (stderr += d));
		p.on("error", reject);
		p.on("close", (code) => resolve({ code, stdout, stderr }));
		p.stdin.end(input);
	});
}

// Copies the server to `host` if needed and registers it. Returns a summary; throws on failure.
async function connect(pi: ExtensionAPI, host: string, signal?: AbortSignal, progress?: (msg: string) => void) {
	// MCP server names allow letters, digits, _ and -.
	const name = host.replace(/^.*@/, "").replace(/[^A-Za-z0-9_-]/g, "_");

	const bundle = join(getPackageDir(), "dist", "bundle");
	if (!existsSync(join(bundle, "index.js"))) throw new Error(`No Pi bundle at ${bundle}; rc needs a Node-based Pi install`);
	// A new Pi version or server.mjs gets a fresh remote dir.
	// shortcut: old dirs under ~/.pi/telepirt stay on the remote, delete them by hand.
	const key = `${VERSION}-${createHash("sha256").update(readFileSync(SERVER)).digest("hex").slice(0, 12)}`;

	const res = await run("ssh", [...OPTS, "--", host, "node -"], probe(key), signal);
	if (res.code === 255) throw new Error(res.stderr.trim() || `ssh to ${host} failed`);
	let remote: { server: string; ready: boolean; platform: string; version: string };
	try {
		remote = JSON.parse(res.stdout.trim().split("\n").pop() ?? "");
	} catch {
		throw new Error(`Node not usable on ${host} (install Node first): ${res.stderr.trim() || res.stdout.trim()}`);
	}

	if (!remote.ready) {
		progress?.(`Copying Pi ${VERSION} tools to ${host}...`);
		// Relative scp paths resolve against the remote home on POSIX and Windows OpenSSH alike.
		// server.mjs goes last, so `ready` means the bundle copy finished.
		const dest = `${host}:.pi/telepirt/${key}/`;
		const cp = await run("scp", ["-q", "-r", ...OPTS, "--", bundle, SERVER, dest], "", signal);
		if (cp.code !== 0) throw new Error(`scp to ${host} failed: ${cp.stderr.trim()}`);
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
	const shell = remote.platform === "win32" ? "powershell" : "bash";
	return `Pi tools on ${host} (${remote.platform}, Node ${remote.version}): tools.mcp__${name}__{read,edit,write,ls,grep,find,${shell}}${hint}`;
}

export default function rcExtension(pi: ExtensionAPI) {
	// shortcut: registrations are per session; rc runs again after /reload or restart. Upgrade: re-register on session_start from a settings key.
	pi.registerCommand("rc", {
		description: "Serve Pi's built-in tools on an SSH host to codemode as mcp__<host>",
		handler: async (args, ctx) => {
			const host = args.trim();
			if (!host) return ctx.ui.notify("Usage: /rc <host | user@host | ssh alias>", "warning");
			try {
				ctx.ui.notify(await connect(pi, host, undefined, (msg) => ctx.ui.notify(msg, "info")), "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	pi.registerTool({
		name: "rc",
		label: "rc",
		description:
			"Connect Pi's read/edit/write/ls/grep/find/bash (powershell on Windows) to an SSH host. " +
			"Then call them from codemode as tools.mcp__<name>__edit({...}), with the name this returns. " +
			"Prefer this over ssh for file work.",
		parameters: Type.Object({
			host: Type.String({ description: "SSH destination: host, user@host, or a ~/.ssh/config alias" }),
		}),
		async execute(_toolCallId, { host }, signal) {
			return { content: [{ type: "text", text: await connect(pi, host, signal) }], details: {} };
		},
	});
}
