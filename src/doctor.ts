/**
 * `cco doctor` — client-side health check for the cco/opencode environment.
 *
 * Runs a sequence of cheap, side-effect-free probes and prints a checklist
 * with a stable error taxonomy (the `code` on each check). Each probe pushes
 * a {@link DoctorCheck}; the overall result is `ok` unless any check failed.
 *
 * Checks: Node version, agent binary on PATH + its version, writable storage
 * root, the live daemon fleet (reachability), and — when a cwd is given — the
 * daemon for the current project. Nothing here mutates state beyond creating
 * the `~/.cco` root if it is missing.
 */

import pc from "picocolors";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { basename, resolve } from "node:path";
import { ccoHome } from "./paths.js";
import {
  readDaemons,
  readDaemonInfo,
  isDaemonAlive,
  DaemonClient,
} from "./daemon/index.js";
import type { StatusResponse } from "./daemon/ipc.js";

export type CheckStatus = "ok" | "warn" | "fail";
export type DoctorCheck = { code: string; status: CheckStatus; detail: string };
export type DoctorResult = { ok: boolean; checks: DoctorCheck[] };

/** Minimum opencode major.minor for the ACP transport cco speaks. */
const MIN_AGENT_VERSION = { major: 1, minor: 15 };
/** Minimum Node major. The daemon and CLI both rely on Node 20+ stream APIs. */
const MIN_NODE_MAJOR = 20;

/** Result of probing the agent binary, threaded from check 2 into check 3. */
type AgentProbe = {
  found: boolean;
  /** Raw version string parsed from `<agent> --version`, if any. */
  version?: string;
};

/**
 * Run all diagnostics and return the aggregated result. Never throws — every
 * probe is individually guarded so a single failure can't abort the checklist.
 */
export async function runDoctor(opts: {
  cwd?: string;
  agent?: string;
  json?: boolean;
}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const agent = opts.agent ?? "opencode";

  // 1. NODE ──────────────────────────────────────────────────────────────────
  checkNode(checks);

  // 2. AGENT_BINARY ────────────────────────────────────────────────────────────
  const probe = await checkAgentBinary(checks, agent);

  // 3. AGENT_VERSION ───────────────────────────────────────────────────────────
  checkAgentVersion(checks, agent, probe);

  // 4. STORAGE ─────────────────────────────────────────────────────────────────
  checkStorage(checks);

  // 5. FLEET ───────────────────────────────────────────────────────────────────
  await checkFleet(checks);

  // 6. PROJECT ─────────────────────────────────────────────────────────────────
  await checkProject(checks, opts.cwd);

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}

// ─── Individual checks ────────────────────────────────────────────────────────

function checkNode(checks: DoctorCheck[]): void {
  const ver = process.versions.node;
  const major = Number.parseInt(ver.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    checks.push({ code: "NODE", status: "ok", detail: `node v${ver}` });
  } else {
    checks.push({
      code: "NODE_TOO_OLD",
      status: "fail",
      detail: `node v${ver} (need >=${MIN_NODE_MAJOR})`,
    });
  }
}

async function checkAgentBinary(
  checks: DoctorCheck[],
  agent: string,
): Promise<AgentProbe> {
  const res = await probeVersion(agent);
  if (!res.spawned) {
    checks.push({
      code: "BINARY_NOT_FOUND",
      status: "fail",
      detail: `${agent} not on PATH`,
    });
    return { found: false };
  }
  const version = res.version;
  checks.push({
    code: "AGENT_BINARY",
    status: "ok",
    detail: version ? `${agent} on PATH (v${version})` : `${agent} on PATH (version unknown)`,
  });
  return { found: true, version };
}

function checkAgentVersion(
  checks: DoctorCheck[],
  agent: string,
  probe: AgentProbe,
): void {
  if (!probe.found) return; // binary missing — already reported as a fail
  const parsed = parseSemverish(probe.version);
  if (!parsed) {
    // Found, but the version string didn't parse — informational, not a failure.
    checks.push({
      code: "AGENT_VERSION",
      status: "ok",
      detail: `${agent} version not parseable — skipping version check`,
    });
    return;
  }
  const tooOld =
    parsed.major < MIN_AGENT_VERSION.major ||
    (parsed.major === MIN_AGENT_VERSION.major && parsed.minor < MIN_AGENT_VERSION.minor);
  if (tooOld) {
    checks.push({
      code: "VERSION_TOO_OLD",
      status: "warn",
      detail: `${agent} v${probe.version} — acp needs >=${MIN_AGENT_VERSION.major}.${MIN_AGENT_VERSION.minor}`,
    });
  } else {
    checks.push({
      code: "AGENT_VERSION",
      status: "ok",
      detail: `${agent} v${probe.version} supports acp`,
    });
  }
}

function checkStorage(checks: DoctorCheck[]): void {
  const home = ccoHome();
  if (!existsSync(home)) {
    try {
      mkdirSync(home, { recursive: true });
    } catch {
      // fall through — the accessSync below will report the failure.
    }
  }
  try {
    accessSync(home, constants.W_OK);
    checks.push({ code: "STORAGE", status: "ok", detail: `${home} writable` });
  } catch {
    checks.push({
      code: "STORAGE_UNWRITABLE",
      status: "fail",
      detail: `${home} not writable`,
    });
  }
}

async function checkFleet(checks: DoctorCheck[]): Promise<void> {
  const daemons = readDaemons();
  if (daemons.length === 0) {
    checks.push({ code: "FLEET", status: "ok", detail: "no daemons running" });
    return;
  }
  for (const d of daemons) {
    if (!isDaemonAlive(d)) {
      checks.push({
        code: "DAEMON_STALE",
        status: "warn",
        detail: `daemon ${basename(d.cwd)}  pid ${d.pid} — stale (process gone)`,
      });
      continue;
    }
    const status = await probeDaemon(d.port, d.token);
    if (status) {
      const agentLabel = `${status.agentName ?? d.agentName ?? "agent"} v${
        status.agentVersion ?? d.agentVersion ?? "?"
      }`;
      const n = status.sessions.length;
      checks.push({
        code: "FLEET",
        status: "ok",
        detail: `daemon ${basename(d.cwd)}  pid ${d.pid}  port ${d.port}  ${agentLabel}  (${n} session${n === 1 ? "" : "s"})`,
      });
    } else {
      checks.push({
        code: "PORT_UNREACHABLE",
        status: "warn",
        detail: `daemon ${basename(d.cwd)}  pid ${d.pid} alive but port ${d.port} unreachable`,
      });
    }
  }
}

async function checkProject(checks: DoctorCheck[], cwd?: string): Promise<void> {
  if (!cwd) return;
  const root = resolve(cwd);
  const info = await readDaemonInfo(root);
  if (!info) {
    checks.push({
      code: "NO_DAEMON",
      status: "ok",
      detail: `no daemon for ${basename(root)} — run cco serve`,
    });
  }
  // If a daemon exists it's already covered by the FLEET check above.
}

// ─── Probes ───────────────────────────────────────────────────────────────────

/**
 * Spawn `<agent> --version`, capture stdout, and parse a semver-ish string.
 * Robust against missing stdout, hangs (5s timeout), and non-zero exits — any
 * of those resolve to "spawned but version unknown" rather than throwing.
 */
function probeVersion(
  agent: string,
): Promise<{ spawned: boolean; version?: string }> {
  return new Promise((resolveP) => {
    let stdout = "";
    let settled = false;
    const done = (r: { spawned: boolean; version?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(r);
    };

    let child;
    try {
      child = spawn(agent, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // Synchronous spawn failure (rare) — treat as not found.
      return done({ spawned: false });
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      // It launched but didn't answer in time — found, version unknown.
      done({ spawned: true, version: extractVersion(stdout) });
    }, 5000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => {
      // ENOENT and friends — the binary isn't on PATH.
      done({ spawned: false });
    });
    child.on("close", () => {
      // Resolve regardless of exit code; a non-zero exit still means it ran.
      done({ spawned: true, version: extractVersion(stdout) });
    });
  });
}

/**
 * Quick reachability probe: connect to a daemon's loopback port and call
 * `status`, racing a ~3s timeout. Returns the status on success or null on any
 * failure (unreachable, auth error, timeout). Always closes the socket.
 */
async function probeDaemon(
  port: number,
  token: string,
): Promise<StatusResponse | null> {
  const client = new DaemonClient(port, token);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect();
    const status = await Promise.race([
      client.call<StatusResponse>("status", {}),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("status probe timed out")), 3000);
      }),
    ]);
    return status;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    client.close();
  }
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/** Pull the first `MAJOR.MINOR[.PATCH...]` token out of arbitrary text. */
function extractVersion(text: string): string | undefined {
  const m = text.match(/\d+\.\d+(?:\.\d+)*/);
  return m ? m[0] : undefined;
}

/** Parse the leading major.minor out of a version string. */
function parseSemverish(version?: string): { major: number; minor: number } | null {
  if (!version) return null;
  const m = version.match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number.parseInt(m[1], 10);
  const minor = Number.parseInt(m[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render a {@link DoctorResult} to stdout. With `json: true` emits one compact
 * JSON line; otherwise a human-readable checklist with a status icon per line
 * and a one-line summary.
 */
export function renderDoctor(result: DoctorResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  process.stdout.write(`${pc.bold("cco doctor")}\n`);
  for (const c of result.checks) {
    process.stdout.write(`  ${icon(c.status)} ${c.detail}\n`);
  }

  if (result.ok) {
    const warns = result.checks.filter((c) => c.status === "warn").length;
    const summary =
      warns > 0
        ? pc.green("all checks passed") + pc.dim(` (${warns} warning${warns === 1 ? "" : "s"})`)
        : pc.green("all checks passed");
    process.stdout.write(`\n${summary}\n`);
  } else {
    const fails = result.checks.filter((c) => c.status === "fail").length;
    const warns = result.checks.filter((c) => c.status === "warn").length;
    const parts = [pc.red(`${fails} failed`)];
    if (warns > 0) parts.push(pc.yellow(`${warns} warning${warns === 1 ? "" : "s"}`));
    process.stdout.write(`\n${parts.join(", ")}\n`);
  }
}

function icon(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return pc.green("✓");
    case "warn":
      return pc.yellow("⚠");
    case "fail":
      return pc.red("✗");
  }
}
