import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DaemonIndexEntry } from "./ipc.js";

const GLOBAL_DIR = join(homedir(), ".cco");
const GLOBAL_PATH = join(GLOBAL_DIR, "daemons.json");

function ensureDir(): void {
  if (!existsSync(GLOBAL_DIR)) {
    mkdirSync(GLOBAL_DIR, { recursive: true });
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
      writeFileSync(GLOBAL_PATH, JSON.stringify(alive, null, 2));
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
  writeFileSync(GLOBAL_PATH, JSON.stringify(existing, null, 2));
}

export function unregisterDaemon(cwd: string): void {
  ensureDir();
  const entries = readDaemons();
  const filtered = entries.filter((e) => e.cwd !== cwd);
  writeFileSync(GLOBAL_PATH, JSON.stringify(filtered, null, 2));
}
