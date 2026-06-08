/**
 * Types for `cco graph` — a declarative task-dependency-DAG batch runner.
 *
 * A graph file lists tasks; each task is one opencode turn (start + wait).
 * Tasks declare `dependsOn` edges and may interpolate an upstream task's
 * result into their prompt with `{{ id.result }}`. The runner walks the DAG,
 * running independent tasks in parallel across daemons while honoring the
 * one-daemon-one-turn lock per resolved cwd.
 */

/**
 * How to respond when opencode raises a permission question mid-turn.
 *   "fail"   → treat the question as a failure (default; safest).
 *   "allow"  → auto-pick the allow option.
 *   "deny"   → auto-pick the reject option.
 *   string[] → case-insensitive title allowlist: allow only when one of the
 *              entries is a substring of the question title, else fail.
 */
export type AutoApprovePolicy = "fail" | "allow" | "deny" | string[];

export type GraphTask = {
  id: string;
  prompt: string;
  dependsOn?: string[];
  cwd?: string;
  timeout?: number;
  autoApprove?: AutoApprovePolicy;
};

export type GraphFile = {
  version?: number;
  defaults?: {
    cwd?: string;
    timeout?: number;
    autoApprove?: AutoApprovePolicy;
  };
  tasks: GraphTask[];
};

export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type TaskRun = {
  id: string;
  status: TaskStatus;
  cwd: string;
  sessionId?: string;
  result?: string;
  error?: string;
  reason?: string;
};

export type GraphResult = {
  ok: boolean;
  tasks: Record<
    string,
    {
      status: TaskStatus;
      sessionId?: string;
      reason?: string;
      result?: string;
      error?: string;
    }
  >;
};

export type RunGraphOpts = {
  defaultCwd: string;
  json?: boolean;
  quiet?: boolean;
  autoApprove?: "allow" | "deny" | "fail";
  noAutoSpawn?: boolean;
  stopSpawned?: boolean;
  timeout?: number;
};
