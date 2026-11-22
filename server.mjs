// Stdio MCP server that serves Pi's built-in tools (read, edit, write, ls, grep, find, bash|powershell).
// Runs on a remote host as `node server.mjs` over ssh, next to a copy of Pi's self-contained
// dist/bundle (see extensions/rc.ts). stdout is protocol only; log to stderr.
import os from "node:os";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "./bundle/index.js";

const cwd = os.homedir();
const shell = process.platform === "win32" ? createPowerShellToolDefinition : createBashToolDefinition;
const tools = new Map(
	[createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createLsToolDefinition,
		createGrepToolDefinition, createFindToolDefinition, shell].map((f) => f(cwd)).map((d) => [d.name, d]),
);
const calls = new Map(); // request id -> AbortController

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

async function callTool(id, { name, arguments: args = {}, _meta } = {}) {
	const def = tools.get(name);
	if (!def) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
	const ac = new AbortController();
	calls.set(id, ac);
	// Keep the client's request timeout (60s default) from firing on long silent commands.
	let progress = 0;
	const beat = _meta?.progressToken !== undefined &&
		setInterval(() => send({ method: "notifications/progress", params: { progressToken: _meta.progressToken, progress: ++progress } }), 20_000);
	try {
		const { content } = await def.execute(String(id), def.prepareArguments?.(args) ?? args, ac.signal, undefined, undefined);
		return { content };
	} catch (err) {
		return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
	} finally {
		clearInterval(beat);
		calls.delete(id);
	}
}

async function handle({ id, method, params }) {
	if (method === "notifications/cancelled") return calls.get(params?.requestId)?.abort();
	if (id === undefined) return; // other notifications, e.g. notifications/initialized
	if (method === "initialize")
		return send({ id, result: {
			protocolVersion: params?.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "telepirt", version: "0.1.0" },
			instructions: `Pi's built-in tools on ${os.hostname()} (${process.platform}). Relative paths resolve against ${cwd}.`,
		} });
	if (method === "ping") return send({ id, result: {} });
	if (method === "tools/list")
		return send({ id, result: { tools: [...tools.values()].map((d) => ({ name: d.name, description: d.description, inputSchema: d.parameters })) } });
	if (method === "tools/call") return send({ id, result: await callTool(id, params) });
	send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// Split on \n only (readline would also split on U+2028/U+2029), strip a trailing \r.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl).replace(/\r$/, "");
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			send({ id: null, error: { code: -32700, message: "Parse error" } });
			continue;
		}
		handle(msg).catch((err) => console.error(err));
	}
});
// ssh went away: stop running commands so they don't outlive the session.
process.stdin.on("end", () => {
	for (const ac of calls.values()) ac.abort();
});
