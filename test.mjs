// Self-check for server.mjs: `node test.mjs`. Uses the managed Pi install, or PI_PACKAGE_DIR
// (the @earendil-works/pi-coding-agent directory) for other installs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const piDir = process.env.PI_PACKAGE_DIR ?? join(homedir(), ".pi/agent/install/releases",
	readFileSync(join(homedir(), ".pi/agent/install/current-version"), "utf8").trim(),
	"node_modules/@earendil-works/pi-coding-agent");

// Same layout the /rc command creates on the remote: server.mjs next to Pi's bundle/.
const dir = mkdtempSync(join(tmpdir(), "telepirt-"));
copyFileSync(new URL("server.mjs", import.meta.url), join(dir, "server.mjs"));
symlinkSync(join(piDir, "dist/bundle"), join(dir, "bundle"));

const server = spawn(process.execPath, [join(dir, "server.mjs")], {
	stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
let buf = "";
let nextId = 1;
server.stdout.setEncoding("utf8").on("data", (chunk) => {
	buf += chunk;
	for (let nl; (nl = buf.indexOf("\n")) >= 0; buf = buf.slice(nl + 1)) {
		const msg = JSON.parse(buf.slice(0, nl));
		pending.get(msg.id)?.(msg);
	}
});
const rpc = (method, params) =>
	new Promise((resolve) => {
		const id = nextId++;
		pending.set(id, resolve);
		server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const text = (r) => r.content.map((c) => c.text).join("");

try {
	const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
	assert.equal(init.result.protocolVersion, "2025-06-18");
	server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

	const names = (await rpc("tools/list")).result.tools.map((t) => t.name).sort();
	const shell = process.platform === "win32" ? "powershell" : "bash";
	assert.deepEqual(names, ["edit", "find", "grep", "ls", "read", "write", shell].sort());
	assert.equal((await rpc("nope")).error.code, -32601);

	// write -> edit -> read round trip
	const file = join(dir, "a.txt");
	assert.ok(!(await call("write", { path: file, content: "one\ntwo\n" })).isError);
	assert.ok(!(await call("edit", { path: file, edits: [{ oldText: "two", newText: "zwei" }] })).isError);
	assert.match(text(await call("read", { path: file })), /one\nzwei/);

	// CRLF + UTF-8 BOM (the Windows failure case) survives an edit
	const crlf = join(dir, "crlf.txt");
	writeFileSync(crlf, "\uFEFFalpha\r\nbeta\r\n");
	assert.ok(!(await call("edit", { path: crlf, edits: [{ oldText: "alpha\nbeta", newText: "alpha\ngamma" }] })).isError);
	assert.equal(readFileSync(crlf, "utf8"), "\uFEFFalpha\r\ngamma\r\n");

	// errors come back as isError results, not protocol errors
	const missing = await call("edit", { path: join(dir, "missing.txt"), edits: [{ oldText: "x", newText: "y" }] });
	assert.equal(missing.isError, true);

	assert.match(text(await call(shell, { command: "echo hi" })), /hi/);
	console.log("ok");
} finally {
	server.kill();
	rmSync(dir, { recursive: true, force: true });
}
