/**
 * ssh - run a command on a remote host.
 *
 * Windows hosts behave like the built-in `powershell` tool (pwsh, else Windows PowerShell),
 * everything else like the built-in `bash` tool. Each command starts fresh in the remote
 * user's home directory, like the built-in tools start in the session cwd.
 *
 * Connections are multiplexed (one master per host, kept 10 minutes after last use) via
 * command-line options, so ~/.ssh/config needs no changes. Auth must be non-interactive.
 */

import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	createPowerShellToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OPTS = [
	"-o", "ControlMaster=auto",
	"-o", "ControlPath=~/.ssh/pi-%C",
	"-o", "ControlPersist=10m",
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
];
const SSH = `exec ssh ${OPTS.join(" ")} --`;

// POSIX single-quoting: close the quote, add an escaped quote, reopen.
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// Same prefix the built-in powershell tool adds.
const UTF8 = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
// cmd.exe (Windows OpenSSH's default shell) can't carry arbitrary text, and -EncodedCommand
// turns errors into CLIXML. So run a constant, cmd-safe -Command and send the script on stdin.
const PS_ARGS =
	'-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "iex ([IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8).ReadToEnd())"';
// -Command exits 1 when the last statement failed; iex swallows that, so restore it.
const PS_STATUS = "\nif (-not $?) { exit 1 }";

// ponytail: abort/timeout kills the local ssh only; the remote command keeps running.
// Upgrade path: tag the remote command and kill it with a second ssh call.
function remoteCommand(host: string, shell: string, command: string) {
	return shell === "bash"
		? `${SSH} ${q(host)} ${q(`bash -c ${q(command)}`)}`
		: `${SSH} ${q(host)} ${q(`${shell} ${PS_ARGS}`)} <<< ${q(UTF8 + command + PS_STATUS)}`;
}

export default function sshExtension(pi: ExtensionAPI) {
	const local = createLocalBashOperations();
	const shells = new Map<string, string>(); // host -> "pwsh" | "powershell" | "bash"

	async function shellFor(host: string, signal?: AbortSignal) {
		let shell = shells.get(host);
		if (shell) return shell;
		// where.exe exists on Windows whether the default shell is cmd or PowerShell; elsewhere it fails.
		const r = await pi.exec("ssh", [...OPTS, "--", host, "where.exe pwsh powershell"], { signal });
		if (r.killed) throw new Error("aborted");
		if (r.code === 255) throw new Error(r.stderr.trim() || `ssh to ${host} failed`);
		shell = /pwsh\.exe/i.test(r.stdout) ? "pwsh" : /powershell\.exe/i.test(r.stdout) ? "powershell" : "bash";
		shells.set(host, shell);
		return shell;
	}

	pi.registerTool({
		name: "ssh",
		label: "ssh",
		description:
			"Execute a command on a remote host over SSH, in the remote user's home directory. " +
			"Windows hosts run PowerShell (pwsh if installed, else Windows PowerShell); other hosts run bash. " +
			"Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). " +
			"If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
		parameters: Type.Object({
			host: Type.String({ description: "SSH destination: host, user@host, or a ~/.ssh/config alias" }),
			command: Type.String({ description: "Command to execute (PowerShell on Windows hosts, bash elsewhere)" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
		}),

		async execute(toolCallId, { host, command, timeout }, signal, onUpdate, ctx) {
			const shell = await shellFor(host, signal);
			const operations: BashOperations = {
				exec: (cmd, cwd, options) => local.exec(remoteCommand(host, shell, cmd), cwd, options),
			};
			const create = shell === "bash" ? createBashToolDefinition : createPowerShellToolDefinition;
			return create(ctx.cwd, { operations }).execute(toolCallId, { command, timeout }, signal, onUpdate, ctx);
		},
	});
}
