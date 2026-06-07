#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { resolve } from "node:path";
import { dispatch } from "./dispatch.js";
import { Daemon, DaemonClient, readDaemonInfo, isDaemonAlive, WAIT_EXIT_CODES } from "./daemon/index.js";
import type { SessionInfo, WaitResult, EventEntry } from "./daemon/ipc.js";
import { StreamRenderer } from "./renderer.js";

const program = new Command();

program
  .name("cco")
  .description("ACP-native dispatch bridge from Claude Code to opencode")
  .version("0.1.0");

// ─── Legacy one-shot dispatch (kept for backwards compat) ────────────────────

program
  .command("dispatch")
  .description("One-shot dispatch: spawn opencode, send task, stream result, exit")
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
  .description("Start the long-lived daemon (keeps opencode alive for multi-turn)")
  .option("-d, --cwd <dir>", "working directory", process.cwd())
  .option("-a, --agent <cmd>", "agent binary", "opencode")
  .option("--agent-arg <arg...>", "extra args after `acp`")
  .option("--stderr", "inherit agent stderr")
  .action(async (opts: any) => {
    try {
      const daemon = new Daemon({
        cwd: opts.cwd,
        agentCommand: opts.agent,
        agentArgs: opts.agentArg,
        inheritStderr: opts.stderr,
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
  .action(async (sessionId: string, opts: any) => {
    try {
      const client = await connectDaemon(opts.cwd);
      const result = await client.call<WaitResult>("wait", {
        sessionId,
        timeout: parseInt(opts.timeout, 10),
      });
      if (opts.quiet) {
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
      const result = await client.call<{
        pid: number;
        agentName: string;
        agentVersion: string;
        sessions: SessionInfo[];
      }>("status", {});
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
            const label = entry.kind === "question" ? pc.yellow("?") : pc.dim("·");
            process.stdout.write(`${label} ${pc.dim(`[${entry.kind}]`)} ${summarize(entry.data)}\n`);
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
      break;
    case "question":
      process.stdout.write(`${pc.yellow("?")} ${pc.bold("question")} from opencode\n`);
      if (r.question) {
        process.stdout.write(`  ${r.question.title}\n`);
        for (const opt of r.question.options) {
          process.stdout.write(`    ${pc.dim(opt.optionId)} — ${opt.name} (${opt.kind})\n`);
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

function renderStatus(s: { pid: number; agentName: string; agentVersion: string; sessions: SessionInfo[] }): void {
  process.stdout.write(`${pc.bold("daemon")} pid=${s.pid}  agent=${s.agentName} v${s.agentVersion}\n\n`);
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
