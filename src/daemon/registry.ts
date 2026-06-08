import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionsPath } from "../paths.js";

/**
 * Persistent session registry at ~/.cco/projects/<encoded-cwd>/sessions.json.
 *
 * The daemon holds live SessionState in memory; this registry survives
 * daemon restarts so sessions can be listed and resumed later.
 * opencode persists the actual conversation server-side — resuming is
 * just ACP `session/resume` with a known sessionId.
 */

export type RegistryEntry = {
  sessionId: string;
  cwd: string;
  firstTask: string;
  turnCount: number;
  lastMessage?: string;
  createdAt: string;
  lastActivityAt: string;
  /** "active" while in daemon memory; "archived" after daemon stops or session ends. */
  state: "active" | "archived";
};

export class SessionRegistry {
  private path: string;
  private entries = new Map<string, RegistryEntry>();

  constructor(cwd: string) {
    this.path = sessionsPath(cwd);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const list = JSON.parse(raw) as RegistryEntry[];
      this.entries = new Map(list.map((e) => [e.sessionId, e]));
    } catch {
      this.entries = new Map();
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const list = [...this.entries.values()].sort(
      (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
    await writeFile(this.path, JSON.stringify(list, null, 2));
  }

  async upsert(entry: RegistryEntry): Promise<void> {
    this.entries.set(entry.sessionId, entry);
    await this.save();
  }

  async touch(
    sessionId: string,
    patch: Partial<Pick<RegistryEntry, "turnCount" | "lastMessage" | "state">>,
  ): Promise<void> {
    const e = this.entries.get(sessionId);
    if (!e) return;
    Object.assign(e, patch, { lastActivityAt: new Date().toISOString() });
    await this.save();
  }

  /** Mark all active sessions as archived (called on daemon shutdown). */
  async archiveAll(): Promise<void> {
    for (const e of this.entries.values()) {
      if (e.state === "active") e.state = "archived";
    }
    await this.save();
  }

  get(sessionId: string): RegistryEntry | undefined {
    return this.entries.get(sessionId);
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  }
}

/** Read the registry directly from disk (for CLI use when daemon is down). */
export async function readRegistry(cwd: string): Promise<RegistryEntry[]> {
  const reg = new SessionRegistry(cwd);
  await reg.load();
  return reg.list();
}
