import { resolve, join } from "node:path";
import pc from "picocolors";
import { connectToOpencodeAgent } from "./connection.js";
import { BridgeClient } from "./client.js";
import { JsonlLogger } from "./logger.js";
import { StreamRenderer } from "./renderer.js";
import { ensureProjectDir } from "./paths.js";

export type DispatchOptions = {
  task: string;
  cwd?: string;
  agentCommand?: string;
  agentArgs?: string[];
  permissionMode?: "auto" | "interactive" | "deny";
  logPath?: string;
  quiet?: boolean;
  verbose?: boolean;
  /** Existing session ID to resume; if absent, a new session is created. */
  resumeSessionId?: string;
  inheritStderr?: boolean;
};

export type DispatchResult = {
  sessionId: string;
  stopReason: string;
  logPath: string;
  initInfo: { protocolVersion: number; agentName?: string; agentVersion?: string };
};

/**
 * One-shot dispatch:
 *   1. Spawn opencode acp
 *   2. Initialize handshake
 *   3. Create or resume session
 *   4. Send the task as a prompt
 *   5. Stream session/update notifications in real time
 *   6. Return when the agent reports a stop reason
 */
export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const logPath =
    opts.logPath ??
    join(ensureProjectDir(cwd), `events-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

  const logger = new JsonlLogger(logPath);
  const renderer = new StreamRenderer({ quiet: opts.quiet, verbose: opts.verbose });
  const client = new BridgeClient({
    cwd,
    permissionMode: opts.permissionMode ?? "auto",
    logger,
    renderer,
  });

  logger.log("dispatch_start", {
    cwd,
    task: opts.task,
    permissionMode: opts.permissionMode ?? "auto",
    resumeSessionId: opts.resumeSessionId,
  });

  if (!opts.quiet) {
    process.stdout.write(`${pc.dim("◇ launching opencode acp…")}\n`);
  }

  const active = await connectToOpencodeAgent({
    agentCommand: opts.agentCommand,
    agentArgs: opts.agentArgs,
    cwd,
    client,
    inheritStderr: opts.inheritStderr,
  });

  logger.log("initialize", active.initResult);

  if (!opts.quiet) {
    const info = active.initResult.agentInfo;
    process.stdout.write(
      `${pc.green("◇")} connected ${pc.dim(`(${info?.name ?? "agent"} v${info?.version ?? "?"}, protocol v${active.initResult.protocolVersion})`)}\n`,
    );
  }

  try {
    let sessionId: string;
    if (opts.resumeSessionId) {
      // resume — falls back to load if resume isn't supported by the agent.
      try {
        await active.connection.resumeSession({
          sessionId: opts.resumeSessionId,
          cwd,
          mcpServers: [],
        });
        sessionId = opts.resumeSessionId;
      } catch {
        await active.connection.loadSession({
          sessionId: opts.resumeSessionId,
          cwd,
          mcpServers: [],
        });
        sessionId = opts.resumeSessionId;
      }
      if (!opts.quiet) process.stdout.write(`${pc.green("◇")} resumed session ${pc.dim(sessionId)}\n`);
    } else {
      const sess = await active.connection.newSession({ cwd, mcpServers: [] });
      sessionId = sess.sessionId;
      if (!opts.quiet) process.stdout.write(`${pc.green("◇")} new session ${pc.dim(sessionId)}\n`);
    }
    logger.log("session_ready", { sessionId });

    if (!opts.quiet) {
      process.stdout.write(`\n${pc.bold("dispatch")} ${opts.task}\n${pc.dim("─".repeat(60))}\n`);
    }

    const result = await active.connection.prompt({
      sessionId,
      prompt: [{ type: "text", text: opts.task }],
    });

    logger.log("prompt_complete", { sessionId, stopReason: result.stopReason });
    renderer.end(result.stopReason);

    if (!opts.quiet) {
      process.stdout.write(pc.dim(`\nevent log: ${logPath}\n`));
      process.stdout.write(pc.dim(`session id: ${sessionId}  (resume with --resume ${sessionId})\n`));
    }

    return {
      sessionId,
      stopReason: result.stopReason,
      logPath,
      initInfo: {
        protocolVersion: active.initResult.protocolVersion,
        agentName: active.initResult.agentInfo?.name,
        agentVersion: active.initResult.agentInfo?.version,
      },
    };
  } finally {
    client.cleanup();
    await active.close();
    await logger.close();
  }
}
