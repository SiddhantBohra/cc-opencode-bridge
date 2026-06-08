import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Single source of truth for where cco keeps its runtime + session state.
 *
 * Everything lives under one per-user root (default `~/.cco`, override with
 * the `CCO_HOME` env var), keyed per project by a readable encoding of the
 * absolute cwd — the same scheme Claude Code uses (`/` → `-`). Nothing is
 * written into the user's project directory.
 *
 *   ~/.cco/
 *     daemons.json                              global fleet index
 *     projects/
 *       -Users-me-my-project/                   one dir per project (encoded cwd)
 *         daemon.json                           { pid, childPid, port, token, … }
 *         sessions.json                         session registry
 *         events-<sid>.jsonl                    per-session event log
 *         daemon-stderr.log                     opencode child stderr
 *
 * The daemon talks to the CLI over loopback TCP (not a Unix socket), so no
 * socket file is needed and no path runs into the ~104-byte sun_path limit.
 */

/** Root dir for all cco state. `CCO_HOME` overrides the default `~/.cco`. */
export function ccoHome(): string {
  const override = process.env.CCO_HOME?.trim();
  return override ? resolve(override) : join(homedir(), ".cco");
}

/** Encode an absolute cwd into one readable path segment (Claude-Code style). */
export function encodeCwd(cwd: string): string {
  return resolve(cwd).replace(/\//g, "-");
}

/** Per-project state dir: `~/.cco/projects/<encoded-cwd>/`. */
export function projectDir(cwd: string): string {
  return join(ccoHome(), "projects", encodeCwd(cwd));
}

/** Create the per-project state dir (recursively) and return its path. */
export function ensureProjectDir(cwd: string): string {
  const dir = projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function daemonInfoPath(cwd: string): string {
  return join(projectDir(cwd), "daemon.json");
}

export function sessionsPath(cwd: string): string {
  return join(projectDir(cwd), "sessions.json");
}

export function stderrLogPath(cwd: string): string {
  return join(projectDir(cwd), "daemon-stderr.log");
}

export function eventsLogPath(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), `events-${sessionId}.jsonl`);
}

/** Global daemon index, shared across all projects. */
export function globalIndexPath(): string {
  return join(ccoHome(), "daemons.json");
}
