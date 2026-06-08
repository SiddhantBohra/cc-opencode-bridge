#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { resolve } from "node:path";
import { dispatch } from "./dispatch.js";
import {
  Daemon,
  DaemonClient,
  readDaemonInfo,
  isDaemonAlive,
  WAIT_EXIT_CODES,
} from "./daemon/index.js";
import type {
  SessionInfo,
  StatusResponse,
  WaitResult,
  EventEntry,
  SessionSnapshot,
} from "./daemon/ipc.js";
import { StreamRenderer } from "./renderer.js";

const program = new Command();

program
  .name("cco")
  .description("ACP-native dispatch bridge from Claude Code to opencode")
  .version("0.1.0");

// ─── Legacy one-shot dispatch (kept for backwards compat) ────────────────────

program
  .command("dispatch")
  .description(
    "One-shot dispatch: spawn opencode, send task, stream result, exit",
  )
  .argument("<task>", "the task description")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .option("-a, --agent <cmd>", "agent binary", "opencode")
  .option("--agent-arg <arg...>", "extra args after `acp`")
  .option("-p, --permission <mode>", "auto | interactive | deny", "auto")
  .option("-l, --log <path>", "JSONL event log path")
  .option("-r, --resume <sessionId>", "resume an existing session")
  .option("-q, --quiet", "suppress pretty output")
  .option("-v, --verbose", "include raw tool I/O")
  .option("--stderr", "inherit agent stderr")
  .action(async (task: string, opts: any) => {
    try {
      const result = await dispatch({
        task,
        cwd: opts.cwd,
        agentCommand: opts.agent,
        agentArgs: opts.agentArg,
        permissionMode: opts.permission,
        logPath: opts.log,
        quiet: opts.quiet,
        verbose: opts.verbose,
        resumeSessionId: opts.resume,
        inheritStderr: opts.stderr,
      });
      process.exit(result.stopReason === "end_turn" ? 0 : 2);
    } catch (err) {
      die(err);
    }
  });

// ─── Daemon-mode commands ────────────────────────────────────────────────────

program
  .command("serve")
  .description(
    "Start the long-lived daemon (keeps opencode alive for multi-turn)",
  )
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .option("-a, --agent <cmd>", "agent binary", "opencode")
  .option("--agent-arg <arg...>", "extra args after `acp`")
  .option("--stderr", "inherit agent stderr")
  .option("--http [port]", "serve a web dashboard (default port 7777)")
  .action(async (opts: any) => {
    try {
      const httpPort = opts.http === undefined ? undefined : (opts.http === true ? 7777 : parseInt(opts.http, 10));
      const daemon = new Daemon({
        cwd: opts.cwd,
        agentCommand: opts.agent,
        agentArgs: opts.agentArg,
        inheritStderr: opts.stderr,
        httpPort,
      });
      await daemon.start();
      // Keep process alive — daemon.start() sets up signal handlers
    } catch (err) {
      die(err);
    }
  });

program
  .command("start")
  .description("Create a session and send the first task")
  .argument("<task>", "the task description")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .action(async (task: string, opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      const result = await client.call<{ sessionId: string }>("start", {
        task,
        cwd: resolve(opts.cwd),
      });
      process.stdout.write(JSON.stringify(result) + "\n");
      client.close();
    } catch (err) {
      die(err);
    }
  });

program
  .command("say")
  .description("Send a follow-up message to an existing session")
  .argument("<sessionId>", "session ID")
  .argument("<text>", "the message text")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .action(async (sessionId: string, text: string, opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      await client.call("say", { sessionId, text });
      client.close();
    } catch (err) {
      die(err);
    }
  });

program
  .command("answer")
  .description("Answer a pending question from opencode")
  .argument("<requestId>", "question request ID (from wait/events output)")
  .argument("<optionId>", "option ID to select (e.g., allow_once, reject_once)")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .action(async (requestId: string, optionId: string, opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      await client.call("answer", { requestId, optionId });
      client.close();
    } catch (err) {
      die(err);
    }
  });

program
  .command("cancel")
  .description("Cancel an in-progress turn")
  .argument("<sessionId>", "session ID")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .action(async (sessionId: string, opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      await client.call("cancel", { sessionId });
      client.close();
    } catch (err) {
      die(err);
    }
  });

program
  .command("wait")
  .description("Block until the turn finishes, a question arrives, or timeout")
  .argument("<sessionId>", "session ID")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .option("-t, --timeout <ms>", "timeout in ms", "300000")
  .option("-q, --quiet", "output only JSON, no pretty rendering")
  .option(
    "-s, --stream",
    "render live progress while waiting, then a ---RESULT--- JSON line",
  )
  .option(
    "-v, --verbose",
    "with --stream: include raw tool inputs/outputs (expanded view)",
  )
  .action(async (sessionId: string, opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);

      // --stream: open a second connection that follows live events and
      // pretty-prints them while the wait call blocks. This makes opencode's
      // thinking/tool-calls visible in real time (e.g. inside Claude Code's
      // Bash output), like watching Claude itself work.
      let eventsClient: DaemonClient | null = null;
      let renderer: StreamRenderer | null = null;
      if (opts.stream) {
        eventsClient = await connectDaemon(opts.cwd);
        renderer = new StreamRenderer({ verbose: !!opts.verbose });
        void eventsClient
          .stream(
            "events",
            { sessionId, since: -1, follow: true },
            (event: unknown) => {
              const entry = event as EventEntry;
              if (entry.kind === "session_update") {
                renderer?.handle(entry.data as any);
              } else if (entry.kind === "question") {
                process.stdout.write(
                  `\n${pc.yellow("?")} ${pc.bold("question")} ${summarize(entry.data)}\n`,
                );
              }
            },
          )
          .catch(() => {
            /* events stream ends when daemon closes the socket */
          });
      }

      const result = await client.call<WaitResult>("wait", {
        sessionId,
        timeout: parseInt(opts.timeout, 10),
      });
      eventsClient?.close();

      if (opts.stream) {
        // Print the closing tag + token usage (context used / window · cost),
        // like Claude Code's end-of-turn summary, before the machine-readable line.
        renderer?.end(result.reason);
        process.stdout.write(`\n---RESULT---\n${JSON.stringify(result)}\n`);
      } else if (opts.quiet) {
        process.stdout.write(JSON.stringify(result) + "\n");
      } else {
        renderWaitResult(result);
      }
      client.close();
      process.exit(WAIT_EXIT_CODES[result.reason] ?? 12);
    } catch (err) {
      die(err);
    }
  });

program
  .command("status")
  .description("Show daemon status and active sessions")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .option("--json", "output as JSON")
  .action(async (opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      const result = await client.call<StatusResponse>("status", {});
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        renderStatus(result);
      }
      client.close();
    } catch (err) {
      die(err);
    }
  });

program
  .command("events")
  .description("Stream events from a session")
  .argument("<sessionId>", "session ID")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .option("-f, --follow", "keep following new events")
  .option("-s, --since <seq>", "events after this sequence number", "0")
  .option("--json", "output raw JSON events")
  .action(async (sessionId: string, opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      const renderer = opts.json ? null : new StreamRenderer();
      await client.stream(
        "events",
        { sessionId, since: parseInt(opts.since, 10), follow: !!opts.follow },
        (event: unknown) => {
          const entry = event as EventEntry;
          if (opts.json) {
            process.stdout.write(JSON.stringify(entry) + "\n");
          } else if (entry.kind === "session_update" && renderer) {
            renderer.handle(entry.data as any);
          } else {
            const label =
              entry.kind === "question" ? pc.yellow("?") : pc.dim("·");
            process.stdout.write(
              `${label} ${pc.dim(`[${entry.kind}]`)} ${summarize(entry.data)}\n`,
            );
          }
        },
      );
      client.close();
    } catch (err) {
      if ((err as Error).message === "daemon disconnected") process.exit(0);
      die(err);
    }
  });

program
  .command("sessions")
  .description("List all known sessions (works even when the daemon is down)")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .option("--json", "output as JSON")
  .action(async (opts: any) => {
    try {
      const { readRegistry } = await import("./daemon/registry.js");
      const entries = await readRegistry(opts.cwd);
      if (opts.json) {
        process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
        return;
      }
      if (entries.length === 0) {
        process.stdout.write(pc.dim("no sessions recorded\n"));
        return;
      }
      for (const e of entries) {
        const stateTag =
          e.state === "active" ? pc.green(e.state) : pc.dim(e.state);
        process.stdout.write(
          `${pc.bold(e.sessionId)}  ${stateTag}  turns=${e.turnCount}  ${pc.dim(e.lastActivityAt)}\n` +
            `  task: ${e.firstTask.slice(0, 100)}${e.firstTask.length > 100 ? "…" : ""}\n` +
            (e.lastMessage
              ? `  last: ${pc.dim(e.lastMessage.slice(0, 100))}\n`
              : ""),
        );
      }
      process.stdout.write(
        pc.dim(
          `\nresume any session with: cco say <sessionId> "<follow-up>" (daemon auto-resumes archived sessions)\n`,
        ),
      );
    } catch (err) {
      die(err);
    }
  });

program
  .command("end")
  .description("Close a session (frees agent resources)")
  .argument("<sessionId>", "session ID")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .action(async (sessionId: string, opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      await client.call("end", { sessionId });
      client.close();
    } catch (err) {
      die(err);
    }
  });

program
  .command("stop")
  .description("Shut down the daemon")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .action(async (opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      await client.call("stop", {});
      process.stdout.write(pc.dim("daemon stopped\n"));
      client.close();
    } catch (err) {
      // Daemon may have already exited by the time we read the response
      if ((err as Error).message?.includes("daemon disconnected")) {
        process.stdout.write(pc.dim("daemon stopped\n"));
      } else {
        die(err);
      }
    }
  });

// ─── Legacy tail command ────────────────────────────────────────────────────

program
  .command("tail")
  .description("Pretty-print events from a JSONL log file")
  .argument("<path>", "path to the JSONL events file")
  .option("-f, --follow", "follow the file as new events arrive")
  .action(async (path: string, opts: any) => {
    const { tailLog } = await import("./tail.js");
    await tailLog(path, { follow: !!opts.follow });
  });

// ─── Logs (tail opencode's captured stderr) ─────────────────────────────────

program
  .command("logs")
  .description("Tail the opencode child process stderr log")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .option("-f, --follow", "follow new log lines as they arrive")
  .option("-n, --lines <count>", "number of lines from the end", "50")
  .action(async (opts: any) => {
    try {
      const { resolve, join } = await import("node:path");
      const { tailTextFile } = await import("./tail.js");
      const logPath = join(resolve(opts.cwd), ".cco", "daemon-stderr.log");
      await tailTextFile(logPath, {
        follow: !!opts.follow,
        lines: parseInt(opts.lines, 10),
      });
    } catch (err) {
      die(err);
    }
  });

// ─── Attach (full-screen live session view) ─────────────────────────────────

program
  .command("attach")
  .description("Live full-screen session view (q to detach)")
  .argument("<sessionId>", "session ID")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .action(async (sessionId: string, opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      const snap = await client.call<SessionSnapshot>("snapshot", {
        sessionId,
      });

      const eventsClient = await connectDaemon(opts.cwd);

      const stdin = process.stdin;
      if (!stdin.isTTY) {
        throw new Error("attach requires a TTY");
      }
      stdin.setRawMode(true);
      stdin.resume();

      // Enter alternate screen buffer
      process.stdout.write("\x1b[?1049h");

      let detached = false;
      let localState: SessionSnapshot = snap;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;

      function draw(): void {
        const lines = renderAttachView(localState);
        process.stdout.write("\x1b[H" + lines.join("\n"));
      }

      function cleanup(): void {
        if (detached) return;
        detached = true;
        process.stdout.write("\x1b[?1049l");
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        stdin.pause();
        client.close();
        eventsClient.close();
      }

      draw();

      stdin.on("data", (buf: Buffer) => {
        const key = buf.toString();
        if (key === "q" || key === "\x03") {
          cleanup();
        }
      });

      process.stdout.on("resize", () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!detached) draw();
        }, 100);
      });

      void eventsClient
        .stream(
          "events",
          { sessionId, since: snap.latestSeq, follow: true },
          (event: unknown) => {
            if (detached) return;
            const entry = event as EventEntry;
            switch (entry.kind) {
              case "turn_start": {
                const d = entry.data as { turnCount?: number };
                localState.turnCount = d.turnCount ?? localState.turnCount + 1;
                localState.status = "running";
                localState.toolCalls = [];
                localState.tokenUsage = {};
                localState.lastThought = undefined;
                localState.lastMessage = undefined;
                localState.pendingQuestion = undefined;
                draw();
                break;
              }
              case "session_update": {
                const u = (entry.data as any)?.update ?? entry.data;
                updateAttachState(localState, u);
                draw();
                break;
              }
              case "question":
                localState.status = "awaiting_answer";
                localState.pendingQuestion = entry.data as any;
                draw();
                break;
              case "answer":
                localState.pendingQuestion = undefined;
                localState.status = "running";
                draw();
                break;
              case "turn_end":
                localState.status = "idle";
                draw();
                break;
              case "cancel":
                localState.status = "cancelled";
                draw();
                break;
            }
          },
        )
        .catch(() => {
          if (!detached) cleanup();
        });

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (detached) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });

      process.exit(0);
    } catch (err) {
      die(err);
    }
  });

// ─── Helpers ────────────────────────────────────────────────────────────────

async function connectDaemon(cwd?: string): Promise<DaemonClient> {
  const info = await readDaemonInfo(cwd ?? process.cwd());
  if (!info) {
    throw new Error(
      `no daemon found. Run ${pc.bold("cco serve")} first, or use ${pc.bold("cco dispatch")} for one-shot mode.`,
    );
  }
  if (!isDaemonAlive(info)) {
    throw new Error(
      `daemon (pid ${info.pid}) is not running. Run ${pc.bold("cco serve")} to restart.`,
    );
  }
  const client = new DaemonClient(info.socketPath);
  await client.connect();
  return client;
}

function renderWaitResult(r: WaitResult): void {
  switch (r.reason) {
    case "end_turn":
      process.stdout.write(`${pc.green("✓")} turn complete\n`);
      if (r.lastMessage) {
        process.stdout.write(
          `\n${pc.cyan("◆ opencode says:")}\n${r.lastMessage.trim()}\n`,
        );
      }
      break;
    case "question":
      process.stdout.write(
        `${pc.yellow("?")} ${pc.bold("question")} from opencode\n`,
      );
      if (r.question) {
        process.stdout.write(`  ${r.question.title}\n`);
        for (const opt of r.question.options) {
          process.stdout.write(
            `    ${pc.dim(opt.optionId)} — ${opt.name} (${opt.kind})\n`,
          );
        }
        process.stdout.write(
          `\n  answer with: ${pc.bold(`cco answer ${r.question.requestId} <optionId>`)}\n`,
        );
      }
      break;
    case "cancelled":
      process.stdout.write(`${pc.yellow("⊘")} turn cancelled\n`);
      break;
    case "error":
      process.stdout.write(`${pc.red("✗")} error: ${r.error}\n`);
      break;
    case "timeout":
      process.stdout.write(`${pc.yellow("⏱")} timeout — turn still running\n`);
      break;
  }
}

function renderStatus(s: StatusResponse): void {
  const childInfo = s.childPid
    ? ` · ${pc.bold("opencode acp")} pid ${s.childPid}`
    : "";
  process.stdout.write(
    `${pc.bold("daemon")} pid ${s.pid}${childInfo}  agent=${s.agentName} v${s.agentVersion}\n\n`,
  );
  if (s.sessions.length === 0) {
    process.stdout.write(pc.dim("  no active sessions\n"));
    return;
  }
  for (const sess of s.sessions) {
    const statusColor =
      sess.status === "idle"
        ? pc.green
        : sess.status === "running"
          ? pc.cyan
          : sess.status === "awaiting_answer"
            ? pc.yellow
            : pc.dim;
    process.stdout.write(
      `  ${pc.bold(sess.sessionId)}  ${statusColor(sess.status)}  turns=${sess.turnCount}  cwd=${pc.dim(sess.cwd)}\n`,
    );
    if (sess.pendingQuestion) {
      process.stdout.write(
        `    ${pc.yellow("?")} ${sess.pendingQuestion.title}  reqid=${sess.pendingQuestion.requestId}\n`,
      );
    }
  }
}

// ─── Attach view helpers ─────────────────────────────────────────────────────

function renderAttachView(s: SessionSnapshot): string[] {
  const lines: string[] = [];
  const statusColor =
    s.status === "idle"
      ? pc.green
      : s.status === "running"
        ? pc.cyan
        : s.status === "awaiting_answer"
          ? pc.yellow
          : pc.red;

  const cols = Math.min(process.stdout.columns || 80, 100);
  const header = `${pc.bold(s.sessionId)} · turn ${s.turnCount} · ${statusColor(s.status)}`;
  // `┌─ ` (3) + header + ` ` (1) + dashes + `┐` (1) = cols  →  pad = cols - visLen(header) - 5
  const headerPad = Math.max(0, cols - visibleLen(header) - 5);
  lines.push(`┌─ ${header} ${"─".repeat(headerPad)}┐`);

  const bodyWidth = cols - 4;

  if (s.lastThought) {
    lines.push(`│ ${pc.dim("💭")} ${truncate(s.lastThought, bodyWidth - 2)} │`);
  }
  if (s.lastMessage && !s.lastThought) {
    lines.push(`│ ${pc.cyan("◆")} ${truncate(s.lastMessage, bodyWidth - 2)} │`);
  }

  for (const tc of s.toolCalls) {
    const icon = attachToolIcon(tc.kind);
    const statusGlyph =
      tc.status === "completed"
        ? pc.green("✓")
        : tc.status === "failed"
          ? pc.red("✗")
          : tc.status === "running"
            ? pc.yellow("⠹")
            : pc.dim("○");
    const title = tc.title || tc.toolCallId;
    const toolLine = `${icon} ${pc.bold(title)}  ${statusGlyph}`;
    const pad = Math.max(0, bodyWidth - visibleLen(toolLine));
    lines.push(`│ ${toolLine}${" ".repeat(pad)} │`);
  }

  const u = s.tokenUsage;
  if (u.used !== undefined) {
    const parts = [`${formatted(u.used)} tokens`];
    if (u.size) {
      const pct = Math.round((u.used / u.size) * 100);
      parts[0] = `${formatted(u.used)} / ${formatted(u.size)} tokens (${pct}%)`;
    }
    if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
    const tokenLine = `context: ${parts.join(" · ")}`;
    const pad = Math.max(0, bodyWidth - visibleLen(tokenLine));
    lines.push(`│ ${pc.dim(tokenLine)}${" ".repeat(pad)} │`);
  }

  if (s.pendingQuestion) {
    lines.push(
      `│ ${pc.yellow("?")} ${pc.bold(s.pendingQuestion.title)}${" ".repeat(Math.max(0, bodyWidth - s.pendingQuestion.title.length - 2))} │`,
    );
    for (const opt of s.pendingQuestion.options) {
      const optLine = `  ${pc.dim(opt.optionId)} — ${opt.name}`;
      const pad = Math.max(0, bodyWidth - optLine.length);
      lines.push(`│ ${optLine}${" ".repeat(pad)} │`);
    }
  }

  const footer = "q to detach";
  // `└` (1) + dashes + ` ` (1) + footer + ` ` (1) + `┘` (1) = cols  →  pad = cols - footer.length - 4
  const footerPad = Math.max(0, cols - footer.length - 4);
  lines.push(`└${"─".repeat(footerPad)} ${footer} ┘`);

  return lines;
}

// Visible character width, ignoring ANSI color/style escape sequences.
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function updateAttachState(s: SessionSnapshot, u: any): void {
  if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
    s.lastMessage = (s.lastMessage ?? "") + u.content.text;
  } else if (
    u.sessionUpdate === "agent_thought_chunk" &&
    u.content?.type === "text"
  ) {
    s.lastThought = (s.lastThought ?? "") + u.content.text;
  } else if (u.sessionUpdate === "tool_call" && u.toolCallId) {
    const idx = s.toolCalls.findIndex((t) => t.toolCallId === u.toolCallId);
    const tc = {
      toolCallId: u.toolCallId,
      kind: u.kind,
      title: u.title,
      status: u.status ?? "pending",
    };
    if (idx >= 0) s.toolCalls[idx] = tc;
    else s.toolCalls.push(tc);
  } else if (u.sessionUpdate === "tool_call_update" && u.toolCallId) {
    const existing = s.toolCalls.find((t) => t.toolCallId === u.toolCallId);
    if (existing) existing.status = u.status ?? existing.status;
    else
      s.toolCalls.push({
        toolCallId: u.toolCallId,
        kind: u.kind,
        title: u.title,
        status: u.status ?? "running",
      });
  } else if (u.sessionUpdate === "usage_update") {
    if (typeof u.used === "number") s.tokenUsage.used = u.used;
    if (typeof u.size === "number") s.tokenUsage.size = u.size;
    if (typeof u.cost?.amount === "number") s.tokenUsage.cost = u.cost.amount;
  }
}

function attachToolIcon(kind?: string): string {
  switch (kind) {
    case "read":
      return pc.blue("⌕");
    case "search":
      return pc.blue("⌕");
    case "edit":
      return pc.yellow("▸");
    case "delete":
      return pc.red("✗");
    case "move":
      return pc.cyan("→");
    case "execute":
      return pc.magenta("$");
    case "think":
      return pc.dim("·");
    case "fetch":
      return pc.cyan("↓");
    default:
      return pc.dim("◇");
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

function formatted(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function summarize(d: unknown): string {
  try {
    const s = JSON.stringify(d);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(d);
  }
}

function die(err: unknown): never {
  process.stderr.write(`${pc.red("error:")} ${(err as Error).message}\n`);
  process.exit(1);
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${pc.red("error:")} ${(err as Error).message}\n`);
  process.exit(1);
});
