import type { ClientSideConnection, SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { EventEntry, PendingQuestion, SessionInfo, SessionSnapshot, SessionStatus, ToolCallSnapshot, WaitResult } from "./ipc.js";
import { JsonlLogger } from "../logger.js";

type Waiter = { resolve: (r: WaitResult) => void; timer?: ReturnType<typeof setTimeout> };
type EventFollower = (entry: EventEntry) => void;

/**
 * Per-session state machine.
 *
 * Lifecycle:  idle → running → (awaiting_answer ↔ running)* → idle
 *
 * Each prompt turn goes through `running` and may pause at
 * `awaiting_answer` if opencode sends `request_permission`.
 * The question is surfaced to all event followers and waiters;
 * an external `answer()` call resolves the pending permission
 * request and transitions back to `running`.
 */
export class SessionState {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: string;

  status: SessionStatus = "idle";
  turnCount = 0;
  lastActivityAt: string;
  /** Accumulated agent message text for the current/most recent turn. */
  private turnMessage = "";
  private turnThought = "";
  private toolCalls = new Map<string, ToolCallSnapshot>();
  private tokenUsage: { used?: number; size?: number; cost?: number } = {};

  private events: EventEntry[] = [];
  private seq = 0;
  private followers = new Set<EventFollower>();
  private waiters: Waiter[] = [];
  private pendingQ: {
    requestId: string;
    params: RequestPermissionRequest;
    resolve: (r: RequestPermissionResponse) => void;
  } | null = null;

  private logger: JsonlLogger;

  constructor(id: string, cwd: string, logPath: string) {
    this.id = id;
    this.cwd = cwd;
    this.createdAt = new Date().toISOString();
    this.lastActivityAt = this.createdAt;
    this.logger = new JsonlLogger(logPath);
  }

  // ─── Event recording ─────────────────────────────────────────────────────

  private emit(kind: string, data: unknown): void {
    const entry: EventEntry = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      sessionId: this.id,
      kind,
      data,
    };
    this.events.push(entry);
    this.logger.log(kind, data);
    this.lastActivityAt = entry.ts;
    for (const f of this.followers) {
      try { f(entry); } catch { /* follower error — don't crash daemon */ }
    }
  }

  /** Called by the ACP client's sessionUpdate handler. */
  onSessionUpdate(n: SessionNotification): void {
    const u = n.update as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
      toolCallId?: string;
      kind?: string;
      title?: string;
      status?: string;
      used?: number;
      size?: number;
      cost?: { amount?: number };
    };
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && u.content.text) {
      this.turnMessage += u.content.text;
    } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text" && u.content.text) {
      this.turnThought += u.content.text;
    } else if (u.sessionUpdate === "tool_call" && u.toolCallId) {
      this.toolCalls.set(u.toolCallId, {
        toolCallId: u.toolCallId,
        kind: u.kind,
        title: u.title,
        status: u.status ?? "pending",
      });
    } else if (u.sessionUpdate === "tool_call_update" && u.toolCallId) {
      const existing = this.toolCalls.get(u.toolCallId);
      if (existing) {
        existing.status = u.status ?? existing.status;
      } else {
        this.toolCalls.set(u.toolCallId, {
          toolCallId: u.toolCallId,
          kind: u.kind,
          title: u.title,
          status: u.status ?? "running",
        });
      }
    } else if (u.sessionUpdate === "usage_update") {
      if (typeof u.used === "number") this.tokenUsage.used = u.used;
      if (typeof u.size === "number") this.tokenUsage.size = u.size;
      if (typeof u.cost?.amount === "number") this.tokenUsage.cost = u.cost.amount;
    }
    this.emit("session_update", n);
  }

  // ─── Question bridge (request_permission ↔ cco answer) ───────────────────

  /**
   * Called by the ACP client when opencode sends request_permission.
   * Returns a promise that resolves when an external CLI call answers it.
   */
  handlePermissionRequest(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = `q_${this.seq + 1}`;
    this.status = "awaiting_answer";

    const question: PendingQuestion = {
      requestId,
      title: params.toolCall.title ?? "permission",
      options: params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
    };
    this.emit("question", question);

    // Notify waiters that a question arrived
    this.resolveWaiters({
      reason: "question",
      sessionId: this.id,
      question,
    });

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingQ = { requestId, params, resolve };
    });
  }

  /**
   * Called by CLI `cco answer <reqid> <optionId>`.
   * Resolves the pending request_permission promise.
   */
  answer(requestId: string, optionId: string): boolean {
    if (!this.pendingQ || this.pendingQ.requestId !== requestId) return false;
    const { resolve } = this.pendingQ;
    this.pendingQ = null;
    this.status = "running";
    this.emit("answer", { requestId, optionId });
    resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }

  /** Cancel a pending permission request (e.g., on session/cancel). */
  cancelPendingQuestion(): void {
    if (!this.pendingQ) return;
    const { resolve, requestId } = this.pendingQ;
    this.pendingQ = null;
    this.emit("question_cancelled", { requestId });
    resolve({ outcome: { outcome: "cancelled" } });
  }

  // ─── Prompt turn lifecycle ────────────────────────────────────────────────

  /**
   * Run a prompt turn. Returns the stop reason (or throws on cancel/error).
   * The turn ends when `session/prompt` resolves.
   */
  async runTurn(
    connection: ClientSideConnection,
    text: string,
  ): Promise<WaitResult> {
    if (this.status !== "idle") {
      throw new Error(`session ${this.id} is ${this.status}, cannot start a new turn`);
    }
    this.status = "running";
    this.turnCount++;
    this.turnMessage = "";
    this.turnThought = "";
    this.toolCalls.clear();
    this.tokenUsage = {};
    this.emit("turn_start", { turnCount: this.turnCount, prompt: text });

    try {
      const result = await connection.prompt({
        sessionId: this.id,
        prompt: [{ type: "text", text }],
      });
      // opencode's prompt response can arrive before the trailing
      // agent_message_chunk events on its async firehose — let them settle
      // so lastMessage carries the complete final message.
      await this.settleMessage();
      this.status = "idle";
      const waitResult: WaitResult = {
        reason: "end_turn",
        sessionId: this.id,
        lastMessage: this.turnMessage || undefined,
      };
      this.emit("turn_end", { stopReason: result.stopReason, lastMessage: waitResult.lastMessage });
      this.resolveWaiters(waitResult);
      return waitResult;
    } catch (err) {
      // opencode emits JSON-RPC error on cancel rather than stopReason "cancelled"
      const msg = (err as Error).message ?? String(err);
      const currentStatus: string = this.status;
      const isCancelled = currentStatus === "cancelled" || /abort|cancel/i.test(msg);
      this.status = "idle";

      const waitResult: WaitResult = {
        reason: isCancelled ? "cancelled" : "error",
        sessionId: this.id,
        error: isCancelled ? undefined : msg,
        lastMessage: this.turnMessage || undefined,
      };
      this.emit("turn_end", { stopReason: waitResult.reason, error: waitResult.error });
      this.resolveWaiters(waitResult);
      return waitResult;
    }
  }

  /**
   * Wait until agent message chunks stop arriving (max ~2s).
   * Resolves early once the message has been stable for 250ms.
   */
  private async settleMessage(): Promise<void> {
    const deadline = Date.now() + 2000;
    let last = this.turnMessage;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (this.turnMessage === last) return;
      last = this.turnMessage;
    }
  }

  /** Cancel an in-flight turn. */
  async cancelTurn(connection: ClientSideConnection): Promise<void> {
    if (this.status !== "running" && this.status !== "awaiting_answer") return;
    this.status = "cancelled";
    this.cancelPendingQuestion();
    this.emit("cancel", {});
    await connection.cancel({ sessionId: this.id });
  }

  // ─── Wait / follow ────────────────────────────────────────────────────────

  /**
   * Block until the current turn reaches a terminal state (end_turn,
   * question, cancelled, error) or timeout.
   */
  waitForTurn(timeout?: number): Promise<WaitResult> {
    // If already idle or has a pending question, resolve immediately.
    if (this.status === "idle") {
      return Promise.resolve({
        reason: "end_turn",
        sessionId: this.id,
        lastMessage: this.turnMessage || undefined,
      });
    }
    if (this.status === "awaiting_answer" && this.pendingQ) {
      return Promise.resolve({
        reason: "question",
        sessionId: this.id,
        question: {
          requestId: this.pendingQ.requestId,
          title: this.pendingQ.params.toolCall.title ?? "permission",
          options: this.pendingQ.params.options.map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind,
          })),
        },
      });
    }

    return new Promise<WaitResult>((resolve) => {
      const waiter: Waiter = { resolve };
      if (timeout && timeout > 0) {
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve({ reason: "timeout", sessionId: this.id });
        }, timeout);
      }
      this.waiters.push(waiter);
    });
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  follow(fn: EventFollower): () => void {
    this.followers.add(fn);
    return () => this.followers.delete(fn);
  }

  /** Get events since a sequence number. */
  eventsSince(since: number): EventEntry[] {
    return this.events.filter((e) => e.seq > since);
  }

  /** Highest sequence number emitted so far. */
  latestSeq(): number {
    return this.seq;
  }

  // ─── Info ─────────────────────────────────────────────────────────────────

  toInfo(): SessionInfo {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      status: this.status,
      turnCount: this.turnCount,
      pendingQuestion: this.pendingQ
        ? {
            requestId: this.pendingQ.requestId,
            title: this.pendingQ.params.toolCall.title ?? "permission",
            options: this.pendingQ.params.options.map((o) => ({
              optionId: o.optionId,
              name: o.name,
              kind: o.kind,
            })),
          }
        : undefined,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.id,
      status: this.status,
      turnCount: this.turnCount,
      lastThought: this.turnThought || undefined,
      lastMessage: this.turnMessage || undefined,
      toolCalls: [...this.toolCalls.values()],
      tokenUsage: { ...this.tokenUsage },
      latestSeq: this.seq,
      pendingQuestion: this.pendingQ
        ? {
            requestId: this.pendingQ.requestId,
            title: this.pendingQ.params.toolCall.title ?? "permission",
            options: this.pendingQ.params.options.map((o) => ({
              optionId: o.optionId,
              name: o.name,
              kind: o.kind,
            })),
          }
        : undefined,
    };
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.cancelPendingQuestion();
    this.resolveWaiters({ reason: "error", sessionId: this.id, error: "session closed" });
    this.followers.clear();
    this.status = "closed";
    await this.logger.close();
  }

  private resolveWaiters(result: WaitResult): void {
    const w = this.waiters.splice(0);
    for (const waiter of w) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  }
}
