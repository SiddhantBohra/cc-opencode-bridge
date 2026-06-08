import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { DaemonIndexEntry } from "./ipc.js";
import { ccoHome, globalIndexPath } from "../paths.js";

const GLOBAL_PATH = globalIndexPath();

// The index holds per-daemon auth tokens, so keep it owner-only (0600).
function writeIndex(entries: DaemonIndexEntry[]): void {
  writeFileSync(GLOBAL_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 });
}

function ensureDir(): void {
  if (!existsSync(ccoHome())) {
    mkdirSync(ccoHome(), { recursive: true });
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDaemons(): DaemonIndexEntry[] {
  ensureDir();
  try {
    const raw = readFileSync(GLOBAL_PATH, "utf8");
    const entries = JSON.parse(raw) as DaemonIndexEntry[];
    const alive = entries.filter((e) => isPidAlive(e.pid));
    if (alive.length !== entries.length) {
      writeIndex(alive);
    }
    return alive;
  } catch {
    return [];
  }
}

export function registerDaemon(entry: DaemonIndexEntry): void {
  ensureDir();
  const existing = readDaemons();
  const idx = existing.findIndex((e) => e.cwd === entry.cwd);
  if (idx >= 0) {
    existing[idx] = entry;
  } else {
    existing.push(entry);
  }
  writeIndex(existing);
}

export function unregisterDaemon(cwd: string): void {
  ensureDir();
  const entries = readDaemons();
  const filtered = entries.filter((e) => e.cwd !== cwd);
  writeIndex(filtered);
}
