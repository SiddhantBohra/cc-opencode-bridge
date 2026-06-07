import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { writeFile, mkdir, unlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type InitializeResponse,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type Client,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { TerminalHost } from "../terminal-host.js";
import { SessionState } from "./session-state.js";
import { SessionRegistry } from "./registry.js";
import type {
  DaemonInfo,
  IpcRequest,
  IpcResponse,
  EventEntry,
  WaitResult,
} from "./ipc.js";

export type DaemonOptions = {
  cwd: string;
  agentCommand?: string;
  agentArgs?: string[];
  inheritStderr?: boolean;
};

/**
 * The daemon process.
 *
 * Spawns one long-lived `opencode acp` subprocess, listens on a
 * Unix domain socket for IPC from CLI subcommands, manages N
 * concurrent sessions with per-session state machines.
 */
export class Daemon {
  private opts: DaemonOptions;
  private server!: Server;
  private child!: ChildProcessWithoutNullStreams;
  private connection!: ClientSideConnection;
  private initResult!: InitializeResponse;
  private sessions = new Map<string, SessionState>();
  private registry!: SessionRegistry;
  private terminalHost = new TerminalHost();
  private socketPath!: string;
  private daemonInfoPath!: string;
  private shuttingDown = false;

  constructor(opts: DaemonOptions) {
    this.opts = { ...opts, cwd: resolve(opts.cwd) };
  }

  /** Start the daemon: spawn opencode, initialize ACP, listen on socket. */
  async start(): Promise<void> {
    const ccoDir = join(this.opts.cwd, ".cco");
    await mkdir(ccoDir, { recursive: true });
    this.socketPath = join(ccoDir, "daemon.sock");
    this.daemonInfoPath = join(ccoDir, "daemon.json");
    this.registry = new SessionRegistry(this.opts.cwd);
    await this.registry.load();

    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath).catch(() => {});
    }

    // Spawn opencode acp
    await this.spawnAgent();

    // Listen for CLI connections
    await this.listen();

    // Write daemon info file
    const info: DaemonInfo = {
      pid: process.pid,
      socketPath: this.socketPath,
      cwd: this.opts.cwd,
      startedAt: new Date().toISOString(),
      agentName: this.initResult.agentInfo?.name,
      agentVersion: this.initResult.agentInfo?.version,
    };
    await writeFile(this.daemonInfoPath, JSON.stringify(info, null, 2));

    // Graceful shutdown
    const shutdown = () => this.stop();
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const agentLabel = `${info.agentName ?? "agent"} v${info.agentVersion ?? "?"}`;
    process.stderr.write(`daemon: listening on ${this.socketPath} (${agentLabel})\n`);
  }

  /** Graceful shutdown. */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    process.stderr.write("daemon: shutting down…\n");

    // Close all sessions (opencode persists them server-side; mark archived)
    for (const sess of this.sessions.values()) {
      await sess.close().catch(() => {});
    }
    this.sessions.clear();
    await this.registry?.archiveAll().catch(() => {});

    // Close terminal host
    this.terminalHost.releaseAll();

    // Close socket server
    this.server?.close();

    // Kill opencode
    try {
      this.child?.stdin?.end();
    } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child?.kill("SIGKILL");
        resolve();
      }, 3000);
      this.child?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child?.kill();
    });

    // Clean up files
    await unlink(this.socketPath).catch(() => {});
    await unlink(this.daemonInfoPath).catch(() => {});

    process.exit(0);
  }

  // ─── Agent lifecycle ──────────────────────────────────────────────────────

  private async spawnAgent(): Promise<void> {
    const cmd = this.opts.agentCommand ?? "opencode";
    const args = ["acp", ...(this.opts.agentArgs ?? [])];

    this.child = spawn(cmd, args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", this.opts.inheritStderr ? "inherit" : "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.on("error", (err) => {
      process.stderr.write(`daemon: agent error: ${err.message}\n`);
      if (!this.shuttingDown) this.stop();
    });

    this.child.on("exit", (code) => {
      if (!this.shuttingDown) {
        process.stderr.write(`daemon: agent exited (code ${code}), shutting down\n`);
        this.stop();
      }
    });

    const writable = Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    // Create ACP client that routes through session state machines
    const daemon = this;
    this.connection = new ClientSideConnection(
      () => daemon.createAcpClient(),
      stream,
    );

    this.initResult = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
  }

  /** Creates the ACP Client that handles agent→client calls. */
  private createAcpClient(): Client {
    const daemon = this;
    return {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        const sess = daemon.sessions.get(params.sessionId);
        if (sess) sess.onSessionUpdate(params);
      },

      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const sess = daemon.sessions.get(params.sessionId);
        if (!sess) {
          // No session found — auto-allow to avoid deadlock
          const allowId = params.options.find((o) => o.kind === "allow_once")?.optionId
            ?? params.options[0]?.optionId ?? "allow";
          return { outcome: { outcome: "selected", optionId: allowId } };
        }
        return sess.handlePermissionRequest(params);
      },

      async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        const { readFile: rf } = await import("node:fs/promises");
        const p = resolve(daemon.opts.cwd, params.path);
        const all = await rf(p, "utf8");
        const lines = all.split("\n");
        const start = (params.line ?? 1) - 1;
        const end = params.limit != null ? start + params.limit : undefined;
        return { content: lines.slice(Math.max(0, start), end).join("\n") };
      },

      async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
        const { writeFile: wf, mkdir: mkd } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        const p = resolve(daemon.opts.cwd, params.path);
        await mkd(dirname(p), { recursive: true });
        await wf(p, params.content, "utf8");
        return {};
      },

      async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
        return daemon.terminalHost.create({
          command: params.command,
          args: params.args,
          cwd: params.cwd ?? daemon.opts.cwd,
          env: params.env,
          outputByteLimit: params.outputByteLimit ?? undefined,
        });
      },

      async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
        return daemon.terminalHost.output(params.terminalId);
      },

      async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
        const s = await daemon.terminalHost.waitForExit(params.terminalId);
        return { exitCode: s.exitCode, signal: s.signal };
      },

      async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
        daemon.terminalHost.kill(params.terminalId);
        return {};
      },

      async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
        daemon.terminalHost.release(params.terminalId);
        return {};
      },
    };
  }

  // ─── Unix socket server ───────────────────────────────────────────────────

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on("error", (err) => {
        process.stderr.write(`daemon: socket error: ${(err as Error).message}\n`);
        reject(err);
      });
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  private handleConnection(socket: Socket): void {
    const rl = createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      try {
        const req = JSON.parse(line) as IpcRequest;
        await this.handleRequest(req, socket);
      } catch (err) {
        const resp: IpcResponse = {
          id: "unknown",
          error: { code: -1, message: (err as Error).message },
        };
        this.sendResponse(socket, resp);
      }
    });
  }

  private sendResponse(socket: Socket, resp: IpcResponse): void {
    if (!socket.writable) return;
    socket.write(JSON.stringify(resp) + "\n");
  }

  private async handleRequest(req: IpcRequest, socket: Socket): Promise<void> {
    try {
      switch (req.method) {
        case "start":
          await this.handleStart(req.id, req.params, socket);
          break;
        case "say":
          await this.handleSay(req.id, req.params, socket);
          break;
        case "answer":
          this.handleAnswer(req.id, req.params, socket);
          break;
        case "cancel":
          await this.handleCancel(req.id, req.params, socket);
          break;
        case "wait":
          await this.handleWait(req.id, req.params, socket);
          break;
        case "status":
          this.handleStatus(req.id, socket);
          break;
        case "events":
          this.handleEvents(req.id, req.params, socket);
          break;
        case "end":
          await this.handleEnd(req.id, req.params, socket);
          break;
        case "stop":
          this.sendResponse(socket, { id: req.id, result: { ok: true } });
          await this.stop();
          break;
        default: {
          const unknown = req as { id: string; method: string };
          this.sendResponse(socket, {
            id: unknown.id,
            error: { code: -32601, message: `unknown method: ${unknown.method}` },
          });
        }
      }
    } catch (err) {
      this.sendResponse(socket, {
        id: req.id,
        error: { code: -1, message: (err as Error).message },
      });
    }
  }

  // ─── Request handlers ─────────────────────────────────────────────────────

  private async handleStart(id: string, params: { task: string; cwd: string }, socket: Socket): Promise<void> {
    const cwd = resolve(params.cwd);
    const sessResp = await this.connection.newSession({ cwd, mcpServers: [] });
    const sid = sessResp.sessionId;

    const sess = this.trackSession(sid, cwd);
    await this.registry.upsert({
      sessionId: sid,
      cwd,
      firstTask: params.task,
      turnCount: 0,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      state: "active",
    });

    this.sendResponse(socket, { id, result: { sessionId: sid } });

    // Start the first turn (fire-and-forget from IPC perspective —
    // the CLI will `wait` for it separately).
    this.runTrackedTurn(sess, params.task);
  }

  private async handleSay(id: string, params: { sessionId: string; text: string }, socket: Socket): Promise<void> {
    let sess = this.sessions.get(params.sessionId);

    // Auto-resume: session not in memory but known to the registry —
    // opencode persists conversations server-side, so session/resume
    // restores full context even across daemon restarts.
    if (!sess) {
      const entry = this.registry.get(params.sessionId);
      if (!entry) throw new Error(`unknown session: ${params.sessionId}`);
      await this.connection.resumeSession({
        sessionId: params.sessionId,
        cwd: entry.cwd,
        mcpServers: [],
      });
      sess = this.trackSession(params.sessionId, entry.cwd);
      sess.turnCount = entry.turnCount;
      await this.registry.touch(params.sessionId, { state: "active" });
    }

    if (sess.status !== "idle") {
      this.sendResponse(socket, {
        id,
        error: { code: -1, message: `session is ${sess.status}, wait for current turn to finish` },
      });
      return;
    }
    this.sendResponse(socket, { id, result: { ok: true } });
    this.runTrackedTurn(sess, params.text);
  }

  /** Create and register an in-memory SessionState. */
  private trackSession(sid: string, cwd: string): SessionState {
    const logPath = join(cwd, ".cco", `events-${sid}.jsonl`);
    const sess = new SessionState(sid, cwd, logPath);
    this.sessions.set(sid, sess);
    return sess;
  }

  /** Run a turn and mirror its outcome into the persistent registry. */
  private runTrackedTurn(sess: SessionState, text: string): void {
    sess
      .runTurn(this.connection, text)
      .then((result) =>
        this.registry.touch(sess.id, {
          turnCount: sess.turnCount,
          lastMessage: result.lastMessage?.slice(0, 500),
        }),
      )
      .catch(() => {});
  }

  private handleAnswer(id: string, params: { requestId: string; optionId: string }, socket: Socket): void {
    // Find the session with this pending question
    for (const sess of this.sessions.values()) {
      if (sess.answer(params.requestId, params.optionId)) {
        this.sendResponse(socket, { id, result: { ok: true } });
        return;
      }
    }
    this.sendResponse(socket, {
      id,
      error: { code: -1, message: `no pending question with requestId: ${params.requestId}` },
    });
  }

  private async handleCancel(id: string, params: { sessionId: string }, socket: Socket): Promise<void> {
    const sess = this.requireSession(params.sessionId);
    await sess.cancelTurn(this.connection);
    this.sendResponse(socket, { id, result: { ok: true } });
  }

  private async handleWait(id: string, params: { sessionId: string; timeout?: number }, socket: Socket): Promise<void> {
    const sess = this.requireSession(params.sessionId);
    const result = await sess.waitForTurn(params.timeout);
    this.sendResponse(socket, { id, result });
  }

  private handleStatus(id: string, socket: Socket): void {
    const sessions = [...this.sessions.values()].map((s) => s.toInfo());
    this.sendResponse(socket, {
      id,
      result: {
        pid: process.pid,
        agentName: this.initResult.agentInfo?.name,
        agentVersion: this.initResult.agentInfo?.version,
        sessions,
      },
    });
  }

  private handleEvents(id: string, params: { sessionId: string; since?: number; follow?: boolean }, socket: Socket): void {
    const sess = this.requireSession(params.sessionId);

    // Send historical events
    const history = sess.eventsSince(params.since ?? 0);
    for (const entry of history) {
      this.sendResponse(socket, { id, event: entry });
    }

    if (!params.follow) {
      this.sendResponse(socket, { id, result: { ok: true, count: history.length } });
      return;
    }

    // Follow mode: keep the socket open and stream new events
    const unsub = sess.follow((entry) => {
      this.sendResponse(socket, { id, event: entry });
    });
    socket.on("close", unsub);
    socket.on("error", unsub);
  }

  private async handleEnd(id: string, params: { sessionId: string }, socket: Socket): Promise<void> {
    const sess = this.requireSession(params.sessionId);
    try {
      await this.connection.closeSession({ sessionId: params.sessionId });
    } catch { /* agent may not support close */ }
    await sess.close();
    this.sessions.delete(params.sessionId);
    await this.registry.touch(params.sessionId, { state: "archived" });
    this.sendResponse(socket, { id, result: { ok: true } });
  }

  private requireSession(id: string): SessionState {
    const sess = this.sessions.get(id);
    if (!sess) throw new Error(`unknown session: ${id}`);
    return sess;
  }
}

// ─── Daemon info helpers (used by CLI to find the socket) ───────────────────

export async function readDaemonInfo(cwd: string): Promise<DaemonInfo | null> {
  const infoPath = join(resolve(cwd), ".cco", "daemon.json");
  try {
    const raw = await readFile(infoPath, "utf8");
    return JSON.parse(raw) as DaemonInfo;
  } catch {
    return null;
  }
}

export function isDaemonAlive(info: DaemonInfo): boolean {
  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}
