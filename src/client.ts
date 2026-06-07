import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import readline from "node:readline/promises";
import pc from "picocolors";
import type {
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { TerminalHost } from "./terminal-host.js";
import { JsonlLogger } from "./logger.js";
import { StreamRenderer } from "./renderer.js";

export type BridgeClientOptions = {
  /** Directory used to resolve relative paths from the agent. */
  cwd: string;
  /** "auto" — auto-allow; "interactive" — prompt user; "deny" — reject all. */
  permissionMode: "auto" | "interactive" | "deny";
  logger: JsonlLogger;
  renderer: StreamRenderer;
};

/**
 * Bridge-side implementation of the ACP Client interface.
 *
 * This is what opencode (the agent) talks to. Every method here is
 * called BY the agent. We:
 *   - Honor fs/read & fs/write directly against the local filesystem
 *   - Spawn real OS processes for terminal/* requests
 *   - Handle permission prompts (auto/interactive/deny)
 *   - Render session/update notifications in real time
 *   - Mirror everything into a JSONL event log
 */
export class BridgeClient implements Client {
  private term = new TerminalHost();
  constructor(private opts: BridgeClientOptions) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.opts.logger.log("session_update", params);
    this.opts.renderer.handle(params);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.opts.logger.log("permission_request", params);

    if (this.opts.permissionMode === "deny") {
      process.stdout.write(pc.red(`\n✗ permission denied: ${params.toolCall.title}\n`));
      return { outcome: { outcome: "selected", optionId: this.firstRejectId(params) } };
    }

    if (this.opts.permissionMode === "auto") {
      const allowId = this.firstAllowId(params) ?? params.options[0]?.optionId;
      if (!allowId) {
        return { outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "allow" } };
      }
      process.stdout.write(pc.dim(`\n· auto-approved: ${params.toolCall.title}\n`));
      return { outcome: { outcome: "selected", optionId: allowId } };
    }

    // Interactive
    process.stdout.write(`\n${pc.yellow("?")} ${pc.bold("permission")} ${params.toolCall.title}\n`);
    params.options.forEach((opt, i) => {
      process.stdout.write(`  ${i + 1}. ${opt.name} ${pc.dim(`(${opt.kind})`)}\n`);
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        const ans = (await rl.question("  choose [1]: ")).trim() || "1";
        const idx = parseInt(ans, 10) - 1;
        if (idx >= 0 && idx < params.options.length) {
          return { outcome: { outcome: "selected", optionId: params.options[idx].optionId } };
        }
        process.stdout.write(pc.red("  invalid choice\n"));
      }
    } finally {
      rl.close();
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.opts.logger.log("fs_read", params);
    const p = this.resolvePath(params.path);
    const all = await readFile(p, "utf8");
    const lines = all.split("\n");
    const start = (params.line ?? 1) - 1;
    const end = params.limit !== undefined && params.limit !== null ? start + params.limit : undefined;
    const content = lines.slice(Math.max(0, start), end).join("\n");
    return { content };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    this.opts.logger.log("fs_write", { path: params.path, bytes: params.content.length });
    const p = this.resolvePath(params.path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, params.content, "utf8");
    return {};
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    this.opts.logger.log("terminal_create", params);
    return this.term.create({
      command: params.command,
      args: params.args,
      cwd: params.cwd ?? this.opts.cwd,
      env: params.env,
      outputByteLimit: params.outputByteLimit ?? undefined,
    });
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    return this.term.output(params.terminalId);
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const s = await this.term.waitForExit(params.terminalId);
    return { exitCode: s.exitCode, signal: s.signal };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    this.term.kill(params.terminalId);
    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    this.term.release(params.terminalId);
    return {};
  }

  /** Release any lingering terminals — call before exiting the process. */
  cleanup(): void {
    this.term.releaseAll();
  }

  private resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.opts.cwd, p);
  }

  private firstAllowId(params: RequestPermissionRequest): string | undefined {
    return (
      params.options.find((o) => o.kind === "allow_always")?.optionId ??
      params.options.find((o) => o.kind === "allow_once")?.optionId
    );
  }

  private firstRejectId(params: RequestPermissionRequest): string {
    return (
      params.options.find((o) => o.kind === "reject_always")?.optionId ??
      params.options.find((o) => o.kind === "reject_once")?.optionId ??
      params.options[0]?.optionId ??
      "reject"
    );
  }
}
