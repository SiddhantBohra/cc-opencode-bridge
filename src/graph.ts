/**
 * `cco graph` — a declarative, client-side task-dependency-DAG runner.
 *
 * A graph run is a batch-runner built entirely on the daemon's existing
 * `start` / `wait` / `answer` / `cancel` / `end` primitives — it adds no
 * server, IPC, or protocol changes. Each task is one opencode turn; tasks
 * declare `dependsOn` edges and may interpolate an upstream task's result
 * into their prompt via `{{ id.result }}`.
 *
 * The scheduler walks the DAG and runs independent tasks in parallel across
 * daemons, but honors the hard invariant that one daemon (one resolved cwd)
 * runs at most ONE turn at a time — enforced here by a per-cwd lock
 * (`busyCwds`). Tasks on different cwds get their own daemon and run truly
 * concurrently; tasks sharing a cwd are serialized.
 */

import { resolve, basename, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { connectDaemon } from "./daemon/connect.js";
import {
  DaemonClient,
  readDaemons,
  readDaemonInfo,
  isDaemonAlive,
} from "./daemon/index.js";
import type { WaitResult, PendingQuestion } from "./daemon/ipc.js";
import type {
  AutoApprovePolicy,
  GraphFile,
  GraphResult,
  GraphTask,
  RunGraphOpts,
  TaskRun,
} from "./graph-types.js";

// ─── Loading ─────────────────────────────────────────────────────────────────

/**
 * Strip `//…EOL` and `/* … *​/` comments from a JSON source, but never inside
 * a string literal. Tracks in-string state and backslash escapes so that, e.g.,
 * a `//` or `/*` that appears within a quoted value is left untouched.
 */
export function stripJsonComments(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // Not in a string or comment.
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  return out;
}

/** Read a graph file (JSON, comments allowed), parse, and validate it. */
export function loadGraph(path: string): GraphFile {
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new Error(`invalid graph JSON in ${path}: ${(err as Error).message}`);
  }
  const graph = parsed as GraphFile;
  validateGraph(graph);
  return graph;
}

/** Find every `{{ id.result[:N] }}` reference in a prompt. */
const TOKEN_RE = /\{\{\s*([\w-]+)\.result(?::(\d+))?\s*\}\}/g;

function referencedIds(prompt: string): string[] {
  const ids = new Set<string>();
  for (const m of prompt.matchAll(TOKEN_RE)) ids.add(m[1]);
  return [...ids];
}

/**
 * Validate structure and dependency wiring. Throws a clear Error on any
 * violation — the CLI maps thrown errors to exit 1.
 */
export function validateGraph(graph: GraphFile): void {
  if (!graph || typeof graph !== "object") {
    throw new Error("graph must be an object with a `tasks` array");
  }
  const tasks = graph.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("graph.tasks must be a non-empty array");
  }

  const byId = new Map<string, GraphTask>();
  for (const t of tasks) {
    if (!t || typeof t.id !== "string" || t.id.length === 0) {
      throw new Error("every task must have a non-empty string `id`");
    }
    if (typeof t.prompt !== "string" || t.prompt.length === 0) {
      throw new Error(`task "${t.id}" must have a non-empty string \`prompt\``);
    }
    if (byId.has(t.id)) {
      throw new Error(`duplicate task id: "${t.id}"`);
    }
    byId.set(t.id, t);
  }

  for (const t of tasks) {
    const deps = t.dependsOn ?? [];
    for (const d of deps) {
      if (!byId.has(d)) {
        throw new Error(`task "${t.id}" dependsOn unknown task "${d}"`);
      }
    }
    // Every {{X.result}} token in the prompt must name a declared dependency —
    // this is the #1 authoring bug, so fail loudly.
    for (const ref of referencedIds(t.prompt)) {
      if (!byId.has(ref)) {
        throw new Error(
          `task "${t.id}" prompt references {{${ref}.result}} but no task "${ref}" exists`,
        );
      }
      if (!deps.includes(ref)) {
        throw new Error(
          `task "${t.id}" prompt references {{${ref}.result}} but "${ref}" is not in its dependsOn`,
        );
      }
    }
  }

  detectCycle(tasks, byId);
}

/** 3-color DFS cycle detection; on a back-edge throw with the cycle path. */
function detectCycle(tasks: GraphTask[], byId: Map<string, GraphTask>): void {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.id, WHITE);
  const stack: string[] = [];

  const visit = (id: string): void => {
    color.set(id, GREY);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const c = color.get(dep);
      if (c === GREY) {
        // Back-edge: reconstruct the cycle from where `dep` sits on the stack.
        const from = stack.indexOf(dep);
        const path = [...stack.slice(from), dep].join(" -> ");
        throw new Error(`cycle detected: ${path}`);
      }
      if (c === WHITE) visit(dep);
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const t of tasks) {
    if (color.get(t.id) === WHITE) visit(t.id);
  }
}

// ─── Effective config ──────────────────────────────────────────────────────

type EffectiveTask = {
  task: GraphTask;
  cwd: string;
  timeout: number;
  policy: AutoApprovePolicy;
};

function resolveTask(task: GraphTask, graph: GraphFile, opts: RunGraphOpts): EffectiveTask {
  const cwd = resolve(task.cwd ?? graph.defaults?.cwd ?? opts.defaultCwd);
  const timeout = task.timeout ?? graph.defaults?.timeout ?? opts.timeout ?? 300000;
  // A run-wide --auto-approve flag (opts.autoApprove) overrides per-task/defaults.
  const policy: AutoApprovePolicy =
    opts.autoApprove ?? task.autoApprove ?? graph.defaults?.autoApprove ?? "fail";
  return { task, cwd, timeout, policy };
}

// ─── Daemon orchestration ──────────────────────────────────────────────────

const cliJsPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

type DaemonSet = {
  clients: Map<string, DaemonClient>;
  spawned: Set<string>;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Ensure a live daemon exists for each distinct cwd, auto-spawning detached
 * `cco serve` processes for any that are missing (unless --no-auto-spawn).
 * Returns connected clients keyed by cwd, plus the set of cwds we spawned.
 */
async function ensureDaemons(
  cwds: string[],
  opts: RunGraphOpts,
): Promise<DaemonSet> {
  const running = new Set(readDaemons().map((d) => resolve(d.cwd)));
  const spawned = new Set<string>();

  for (const cwd of cwds) {
    if (running.has(cwd)) continue;
    if (opts.noAutoSpawn) {
      throw new Error(`no daemon for ${cwd}. Run: cco serve --cwd ${cwd}`);
    }
    spawn(process.execPath, [cliJsPath, "serve", "--cwd", cwd], {
      detached: true,
      stdio: "ignore",
      cwd,
    }).unref();
    spawned.add(cwd);
  }

  // Poll each freshly-spawned daemon until it's alive (up to 15s).
  for (const cwd of spawned) {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      const info = await readDaemonInfo(cwd);
      if (info && isDaemonAlive(info)) {
        ready = true;
        break;
      }
      await sleep(200);
    }
    if (!ready) {
      throw new Error(`daemon for ${cwd} did not come up within 15s`);
    }
  }

  const clients = new Map<string, DaemonClient>();
  for (const cwd of cwds) {
    if (clients.has(cwd)) continue;
    clients.set(cwd, await connectDaemon(cwd));
  }

  return { clients, spawned };
}

// ─── Prompt interpolation ──────────────────────────────────────────────────

/**
 * Replace `{{ id.result }}` / `{{ id.result:N }}` with the upstream run's
 * result (sliced to N chars when given). Unresolved tokens are left literal.
 */
export function substitute(prompt: string, runsById: Map<string, TaskRun>): string {
  return prompt.replace(TOKEN_RE, (whole, id: string, n?: string) => {
    const run = runsById.get(id);
    if (!run || run.result === undefined) return whole;
    const value = run.result;
    return n ? value.slice(0, parseInt(n, 10)) : value;
  });
}

// ─── Permission policy ─────────────────────────────────────────────────────

type PolicyDecision = { kind: "answer"; optionId: string } | { kind: "fail" };

export function applyPolicy(
  policy: AutoApprovePolicy,
  question: PendingQuestion,
): PolicyDecision {
  const options = question.options;

  const pickAllow = (): PolicyDecision => {
    const optionId =
      options.find((o) => o.kind === "allow_once")?.optionId ??
      options.find((o) => o.kind?.startsWith("allow"))?.optionId ??
      options[0]?.optionId;
    return optionId ? { kind: "answer", optionId } : { kind: "fail" };
  };

  if (policy === "allow") return pickAllow();

  if (policy === "deny") {
    const optionId =
      options.find((o) => o.kind === "reject_once")?.optionId ??
      options.find((o) => o.kind?.startsWith("reject"))?.optionId ??
      options[options.length - 1]?.optionId;
    return optionId ? { kind: "answer", optionId } : { kind: "fail" };
  }

  if (Array.isArray(policy)) {
    const title = question.title.toLowerCase();
    const allowed = policy.some((entry) => title.includes(entry.toLowerCase()));
    return allowed ? pickAllow() : { kind: "fail" };
  }

  // "fail" (and any unexpected value) → never auto-answer.
  return { kind: "fail" };
}

// ─── Single task execution ─────────────────────────────────────────────────

async function runTask(
  eff: EffectiveTask,
  run: TaskRun,
  client: DaemonClient,
  runsById: Map<string, TaskRun>,
): Promise<void> {
  const prompt = substitute(eff.task.prompt, runsById);

  const { sessionId } = await client.call<{ sessionId: string }>("start", {
    task: prompt,
    cwd: run.cwd,
  });
  run.sessionId = sessionId;

  // Drive the turn: wait, and on a question apply the policy and answer (loop)
  // or cancel + fail. Other terminal reasons map straight to run status.
  for (;;) {
    const r = await client.call<WaitResult>("wait", { sessionId, timeout: eff.timeout });

    switch (r.reason) {
      case "end_turn": {
        run.status = "done";
        run.result = r.lastMessage ?? "";
        run.reason = "end_turn";
        await client.call("end", { sessionId }).catch(() => {});
        return;
      }
      case "question": {
        const q = r.question;
        if (!q) {
          await client.call("cancel", { sessionId }).catch(() => {});
          run.status = "failed";
          run.error = "question without payload";
          run.reason = "question";
          return;
        }
        const decision = applyPolicy(eff.policy, q);
        if (decision.kind === "answer") {
          await client.call("answer", { requestId: q.requestId, optionId: decision.optionId });
          continue;
        }
        await client.call("cancel", { sessionId }).catch(() => {});
        run.status = "failed";
        run.error = `unapproved question: ${q.title}`;
        run.reason = "question";
        return;
      }
      case "timeout": {
        await client.call("cancel", { sessionId }).catch(() => {});
        run.status = "failed";
        run.error = `timed out after ${eff.timeout}ms`;
        run.reason = "timeout";
        return;
      }
      case "cancelled":
      case "error":
      default: {
        run.status = "failed";
        run.error = r.error ?? r.reason;
        run.reason = r.reason;
        return;
      }
    }
  }
}

// ─── Progress + summary rendering ──────────────────────────────────────────

function short(s: string | undefined, n = 60): string {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

function lane(cwd: string): string {
  return pc.dim(`[${basename(cwd)}]`);
}

function progressLine(run: TaskRun): string {
  switch (run.status) {
    case "running":
      return `${pc.cyan("▸")} ${run.id} ${lane(run.cwd)} ${pc.dim("running…")}`;
    case "done":
      return `${pc.green("✓")} ${run.id} ${lane(run.cwd)} ${pc.dim(short(run.result))}`;
    case "failed":
      return `${pc.red("✗")} ${run.id} ${lane(run.cwd)} ${pc.red(short(run.error))}`;
    case "skipped":
      return `${pc.dim("⊘")} ${run.id} ${lane(run.cwd)} ${pc.dim(short(run.error))}`;
    default:
      return `  ${run.id} ${lane(run.cwd)}`;
  }
}

function statusGlyph(status: TaskRun["status"]): string {
  switch (status) {
    case "done":
      return pc.green("✓ done");
    case "failed":
      return pc.red("✗ failed");
    case "skipped":
      return pc.dim("⊘ skipped");
    case "running":
      return pc.cyan("▸ running");
    default:
      return pc.dim("· pending");
  }
}

function printSummary(runs: TaskRun[]): void {
  const idW = Math.max(2, ...runs.map((r) => r.id.length));
  const laneW = Math.max(4, ...runs.map((r) => basename(r.cwd).length + 2));
  process.stdout.write("\n" + pc.bold("graph summary") + "\n");
  for (const run of runs) {
    const id = run.id.padEnd(idW);
    const laneTag = `[${basename(run.cwd)}]`.padEnd(laneW);
    const detail = run.status === "failed" ? short(run.error) : short(run.result);
    process.stdout.write(
      `  ${id}  ${statusGlyph(run.status)}  ${pc.dim(laneTag)}  ${pc.dim(detail)}\n`,
    );
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

/**
 * Run a graph: validate, ensure daemons, then walk the DAG running ready
 * tasks in parallel across cwds (one in-flight turn per cwd). Returns a
 * structured result; prints compact progress + a summary unless quiet/json.
 */
export async function runGraph(graph: GraphFile, opts: RunGraphOpts): Promise<GraphResult> {
  validateGraph(graph);

  const effById = new Map<string, EffectiveTask>();
  for (const task of graph.tasks) {
    effById.set(task.id, resolveTask(task, graph, opts));
  }

  const distinctCwds = [...new Set([...effById.values()].map((e) => e.cwd))];
  const { clients, spawned } = await ensureDaemons(distinctCwds, opts);

  const runsById = new Map<string, TaskRun>();
  for (const [id, eff] of effById) {
    runsById.set(id, { id, status: "pending", cwd: eff.cwd });
  }

  const verbose = !opts.quiet && !opts.json;
  const emit = (run: TaskRun): void => {
    if (verbose) process.stdout.write(progressLine(run) + "\n");
  };

  const busyCwds = new Set<string>();
  const inflight = new Map<string, Promise<void>>();

  const allTerminal = (): boolean =>
    [...runsById.values()].every(
      (r) => r.status === "done" || r.status === "failed" || r.status === "skipped",
    );

  try {
    while (!allTerminal()) {
      let progressed = false;

      for (const [id, run] of runsById) {
        if (run.status !== "pending") continue;
        const eff = effById.get(id)!;
        const deps = eff.task.dependsOn ?? [];

        // If any dependency failed or was skipped, this task can never run.
        const broken = deps.find((d) => {
          const dr = runsById.get(d);
          return dr && (dr.status === "failed" || dr.status === "skipped");
        });
        if (broken) {
          run.status = "skipped";
          run.error = `dependency ${broken} failed`;
          run.reason = "skipped";
          emit(run);
          progressed = true;
          continue;
        }

        // Ready when all deps are done, the cwd lane is free, and it's not
        // already in flight.
        const ready = deps.every((d) => runsById.get(d)?.status === "done");
        if (!ready || busyCwds.has(eff.cwd) || inflight.has(id)) continue;

        busyCwds.add(eff.cwd);
        run.status = "running";
        emit(run);
        progressed = true;

        const client = clients.get(eff.cwd)!;
        const p = runTask(eff, run, client, runsById)
          .catch((err: unknown) => {
            run.status = "failed";
            run.error = err instanceof Error ? err.message : String(err);
            run.reason = run.reason ?? "error";
          })
          .finally(() => {
            busyCwds.delete(eff.cwd);
            inflight.delete(id);
            emit(run);
          });
        inflight.set(id, p);
      }

      if (inflight.size > 0) {
        await Promise.race(inflight.values());
      } else if (!progressed) {
        // No in-flight work and nothing advanced — shouldn't happen after the
        // cycle check, but break rather than spin forever.
        break;
      }
    }
  } finally {
    // Best-effort: stop daemons we spawned, then close every client.
    if (opts.stopSpawned) {
      for (const cwd of spawned) {
        const client = clients.get(cwd);
        if (client) {
          await client.call("stop", {}).catch(() => {});
        } else {
          spawn(process.execPath, [cliJsPath, "stop", "--cwd", cwd], {
            detached: true,
            stdio: "ignore",
            cwd,
          }).unref();
        }
      }
    }
    for (const client of clients.values()) {
      client.close();
    }
  }

  const runs = [...runsById.values()];
  if (!opts.json && !opts.quiet) printSummary(runs);

  const result: GraphResult = {
    ok: runs.every((r) => r.status === "done"),
    tasks: {},
  };
  for (const run of runs) {
    result.tasks[run.id] = {
      status: run.status,
      sessionId: run.sessionId,
      reason: run.reason,
      result: run.result,
      error: run.error,
    };
  }
  return result;
}
