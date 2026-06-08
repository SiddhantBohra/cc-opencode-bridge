/**
 * IPC protocol between CLI subcommands and the daemon.
 *
 * Transport: NDJSON over loopback TCP (127.0.0.1, ephemeral port from
 * daemon.json). Each CLI invocation connects, sends one Request carrying the
 * daemon's auth token, reads Responses (one or many for streaming), then closes.
 *
 * This is a simplified JSON-RPC 2.0 subset — no batching, no notifications
 * from client to daemon (except disconnect = implicit cancel-follow).
 */

// ─── Requests (CLI → daemon) ────────────────────────────────────────────────

export type IpcRequest =
  | { id: string; method: "start"; params: StartParams }
  | { id: string; method: "say"; params: SayParams }
  | { id: string; method: "answer"; params: AnswerParams }
  | { id: string; method: "cancel"; params: CancelParams }
  | { id: string; method: "wait"; params: WaitParams }
  | { id: string; method: "status"; params: StatusParams }
  | { id: string; method: "events"; params: EventsParams }
  | { id: string; method: "snapshot"; params: SnapshotParams }
  | { id: string; method: "end"; params: EndParams }
  | { id: string; method: "stop"; params: StopParams };

export type StartParams = { task: string; cwd: string };
export type SayParams = { sessionId: string; text: string };
export type AnswerParams = { requestId: string; optionId: string; text?: string };
export type CancelParams = { sessionId: string };
export type WaitParams = { sessionId: string; timeout?: number };
export type StatusParams = Record<string, never>;
export type EventsParams = { sessionId: string; since?: number; follow?: boolean };
export type SnapshotParams = { sessionId: string };
export type EndParams = { sessionId: string };
export type StopParams = Record<string, never>;

export type ToolCallSnapshot = {
  toolCallId: string;
  kind?: string;
  title?: string;
  status: string;
  content?: unknown[];
};
export type SessionSnapshot = {
  sessionId: string;
  status: SessionStatus;
  turnCount: number;
  lastThought?: string;
  lastMessage?: string;
  toolCalls: ToolCallSnapshot[];
  // opencode's usage_update reports a single `used` token count against the
  // context window `size`, plus session `cost` — not an input/output split.
  tokenUsage: { used?: number; size?: number; cost?: number };
  pendingQuestion?: PendingQuestion;
  latestSeq: number;
};

export type StatusResponse = {
  pid: number;
  childPid?: number;
  agentName?: string;
  agentVersion?: string;
  sessions: SessionInfo[];
};

// ─── Responses (daemon → CLI) ───────────────────────────────────────────────

export type IpcResponse =
  | { id: string; result: unknown }
  | { id: string; error: { code: number; message: string } }
  | { id: string; event: EventEntry };

// ─── Shared types ───────────────────────────────────────────────────────────

export type SessionStatus = "idle" | "running" | "awaiting_answer" | "cancelled" | "closed";

export type SessionInfo = {
  sessionId: string;
  cwd: string;
  status: SessionStatus;
  turnCount: number;
  pendingQuestion?: PendingQuestion;
  createdAt: string;
  lastActivityAt: string;
};

export type PendingQuestion = {
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type EventEntry = {
  seq: number;
  ts: string;
  sessionId: string;
  kind: string;
  data: unknown;
};

// ─── Wait result exit reasons ───────────────────────────────────────────────

export type WaitReason = "end_turn" | "question" | "cancelled" | "error" | "timeout";

export type WaitResult = {
  reason: WaitReason;
  sessionId: string;
  question?: PendingQuestion;
  error?: string;
  /** Full text of opencode's final message for the turn (agent_message_chunks joined). */
  lastMessage?: string;
};

// ─── Exit codes for `cco wait` ──────────────────────────────────────────────

export const WAIT_EXIT_CODES: Record<WaitReason, number> = {
  end_turn: 0,
  question: 10,
  cancelled: 11,
  error: 12,
  timeout: 13,
};

// ─── Daemon info file (~/.cco/projects/<encoded-cwd>/daemon.json) ────────────

export type DaemonInfo = {
  pid: number;
  childPid?: number;
  /** Loopback TCP port the daemon listens on (replaces the old Unix socket). */
  port: number;
  /** Per-daemon auth token; CLI clients must present it on every request. */
  token: string;
  cwd: string;
  startedAt: string;
  agentName?: string;
  agentVersion?: string;
};

/** Entry in the global daemon index (~/.cco/daemons.json). Same shape as DaemonInfo. */
export type DaemonIndexEntry = DaemonInfo;
