import pc from "picocolors";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { renderDiff } from "./diff.js";

export type RendererOptions = {
  /** Suppress all output (useful for machine-readable mode where only the JSONL log matters). */
  quiet?: boolean;
  /** Print verbose details for tool calls (full input/output JSON). */
  verbose?: boolean;
};

/**
 * Pretty-prints ACP session/update notifications to the terminal.
 *
 * Keeps state for streaming text chunks (so agent_message_chunk events
 * render as one continuous block rather than one log line per token).
 */
export class StreamRenderer {
  private opts: RendererOptions;
  private inMessage = false;
  private inThought = false;
  private lastToolStatus = new Map<string, string>();
  private tokenUsage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {};

  constructor(opts: RendererOptions = {}) {
    this.opts = opts;
  }

  handle(n: SessionNotification): void {
    if (this.opts.quiet) return;
    const u = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        this.streamChunk(u.content, "message");
        break;
      case "agent_thought_chunk":
        this.streamChunk(u.content, "thought");
        break;
      case "user_message_chunk":
        this.closeStream();
        if (u.content.type === "text") {
          process.stdout.write(pc.dim(`\n${pc.bold("you")} ${u.content.text}\n`));
        }
        break;
      case "tool_call":
        this.closeStream();
        this.renderToolCall(u);
        break;
      case "tool_call_update":
        this.closeStream();
        this.renderToolCallUpdate(u);
        break;
      case "plan":
        this.closeStream();
        this.renderPlan(u);
        break;
      case "usage_update":
        this.trackUsage(u);
        break;
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "plan_update":
      case "plan_removed":
        // Quiet on these — they're metadata churn.
        break;
      default:
        this.closeStream();
        process.stdout.write(pc.dim(`[${(u as any).sessionUpdate}]\n`));
    }
  }

  /** Call when the prompt turn completes — flushes any open streams. */
  end(stopReason: string): void {
    if (this.opts.quiet) return;
    this.closeStream();
    const tag =
      stopReason === "end_turn"
        ? pc.green("done")
        : stopReason === "cancelled"
          ? pc.yellow("cancelled")
          : pc.red(stopReason);
    process.stdout.write(`\n${pc.dim("─".repeat(60))}\n${tag}`);
    const usage = this.formatUsage();
    if (usage) process.stdout.write(pc.dim(`  ${usage}`));
    process.stdout.write("\n");
  }

  private trackUsage(u: any): void {
    // ACP shape varies by agent; accept a few common ones.
    const t = u.tokens ?? u.usage ?? u;
    if (typeof t.inputTokens === "number") this.tokenUsage.input = t.inputTokens;
    if (typeof t.outputTokens === "number") this.tokenUsage.output = t.outputTokens;
    if (typeof t.cacheReadInputTokens === "number") this.tokenUsage.cacheRead = t.cacheReadInputTokens;
    if (typeof t.cacheWriteInputTokens === "number") this.tokenUsage.cacheWrite = t.cacheWriteInputTokens;
  }

  private formatUsage(): string {
    const u = this.tokenUsage;
    const parts: string[] = [];
    if (u.input !== undefined) parts.push(`in:${u.input}`);
    if (u.output !== undefined) parts.push(`out:${u.output}`);
    if (u.cacheRead !== undefined) parts.push(`cache_r:${u.cacheRead}`);
    if (u.cacheWrite !== undefined) parts.push(`cache_w:${u.cacheWrite}`);
    return parts.length ? `tokens — ${parts.join(" · ")}` : "";
  }

  private streamChunk(content: any, kind: "message" | "thought"): void {
    if (content.type !== "text") {
      this.closeStream();
      process.stdout.write(pc.dim(`[${content.type}]\n`));
      return;
    }
    if (kind === "thought") {
      if (!this.inThought) {
        this.closeStream();
        process.stdout.write(pc.dim("\n· thinking · "));
        this.inThought = true;
      }
      process.stdout.write(pc.dim(content.text));
    } else {
      if (!this.inMessage) {
        this.closeStream();
        process.stdout.write(`\n${pc.cyan("◆")} `);
        this.inMessage = true;
      }
      process.stdout.write(content.text);
    }
  }

  private closeStream(): void {
    if (this.inMessage || this.inThought) {
      process.stdout.write("\n");
      this.inMessage = false;
      this.inThought = false;
    }
  }

  private renderToolCall(u: any): void {
    const icon = toolIcon(u.kind);
    const title = u.title || u.toolCallId || "tool";
    process.stdout.write(`\n${icon} ${pc.bold(title)} ${pc.dim(`[${u.status ?? "pending"}]`)}\n`);
    if (this.opts.verbose && u.rawInput) {
      process.stdout.write(pc.dim(indent(JSON.stringify(u.rawInput, null, 2), 4)) + "\n");
    }
    if (Array.isArray(u.content)) {
      for (const c of u.content) this.renderToolContent(c);
    }
  }

  private renderToolCallUpdate(u: any): void {
    // Dedupe consecutive identical-status updates — agents (opencode in
    // particular) emit one tool_call_update per output chunk while a
    // command runs, all marked "in_progress". Render status changes only.
    const prev = this.lastToolStatus.get(u.toolCallId);
    const isTerminal = u.status === "completed" || u.status === "failed";
    if (u.status && u.status !== prev) {
      this.lastToolStatus.set(u.toolCallId, u.status);
      const tail =
        u.status === "completed"
          ? pc.green("✓ completed")
          : u.status === "failed"
            ? pc.red("✗ failed")
            : pc.yellow(u.status);
      process.stdout.write(`  ${pc.dim("└")} ${tail}\n`);
    }
    if (Array.isArray(u.content)) {
      for (const c of u.content) this.renderToolContent(c);
    }
    if (this.opts.verbose && u.rawOutput !== undefined && isTerminal) {
      process.stdout.write(pc.dim(indent(JSON.stringify(u.rawOutput, null, 2), 4)) + "\n");
    }
  }

  private renderToolContent(c: any): void {
    if (!c || typeof c !== "object") return;
    if (c.type === "content" && c.content?.type === "text") {
      const text: string = c.content.text;
      const preview = text.length > 600 ? text.slice(0, 600) + "…" : text;
      process.stdout.write(pc.dim(indent(preview, 4)) + "\n");
    } else if (c.type === "diff") {
      // Claude-Code-style colored diff: red deletions, green additions,
      // dim context, unchanged regions collapsed.
      process.stdout.write(pc.bold(pc.dim(`    ── ${c.path}\n`)));
      const rendered = renderDiff(c.oldText, c.newText ?? "", { indent: "    " });
      if (rendered) process.stdout.write(rendered + "\n");
    } else if (c.type === "terminal") {
      process.stdout.write(pc.dim(`    [terminal: ${c.terminalId}]\n`));
    }
  }

  private renderPlan(u: any): void {
    process.stdout.write(`\n${pc.magenta("▦ plan")}\n`);
    if (Array.isArray(u.entries)) {
      for (const e of u.entries) {
        const mark =
          e.status === "completed" ? pc.green("✓") : e.status === "in_progress" ? pc.yellow("◐") : pc.dim("○");
        process.stdout.write(`  ${mark} ${e.content}\n`);
      }
    }
  }
}

function toolIcon(kind?: string): string {
  switch (kind) {
    case "read":
      return pc.blue("⌕");
    case "edit":
      return pc.yellow("✎");
    case "delete":
      return pc.red("✗");
    case "move":
      return pc.cyan("→");
    case "search":
      return pc.blue("⌕");
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

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
