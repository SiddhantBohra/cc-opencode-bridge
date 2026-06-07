#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { dispatch } from "./dispatch.js";

const program = new Command();

program
  .name("cco")
  .description("ACP-native dispatch bridge from Claude Code to opencode")
  .version("0.1.0");

program
  .command("dispatch")
  .description("Send a task to opencode over ACP and stream the result in real time")
  .argument("<task>", "the task description to send to opencode")
  .option("-d, --cwd <dir>", "working directory for the agent", process.cwd())
  .option("-a, --agent <cmd>", "agent binary (default: opencode)", "opencode")
  .option("--agent-arg <arg...>", "extra args to pass after `acp` to the agent")
  .option("-p, --permission <mode>", "permission mode: auto | interactive | deny", "auto")
  .option("-l, --log <path>", "JSONL event log path (default: ./.cco/events-<ts>.jsonl)")
  .option("-r, --resume <sessionId>", "resume an existing session instead of creating new")
  .option("-q, --quiet", "suppress pretty output (events only in JSONL log)")
  .option("-v, --verbose", "include raw tool inputs/outputs in pretty output")
  .option("--stderr", "inherit opencode's stderr (for debugging the agent)")
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
      process.stderr.write(`${pc.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("tail")
  .description("Pretty-print events from a JSONL log file (replay or live tail)")
  .argument("<path>", "path to the JSONL events file")
  .option("-f, --follow", "follow the file as new events arrive")
  .action(async (path: string, opts: any) => {
    const { tailLog } = await import("./tail.js");
    await tailLog(path, { follow: !!opts.follow });
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${pc.red("error:")} ${(err as Error).message}\n`);
  process.exit(1);
});
