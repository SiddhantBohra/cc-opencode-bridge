import pc from "picocolors";
import { readDaemonInfo, isDaemonAlive } from "./daemon.js";
import { DaemonClient } from "./client-ipc.js";

/**
 * Resolve a cwd's daemon (port + token from its daemon.json), verify it's
 * alive, and return a connected, authenticated client. Shared by the CLI
 * commands, the graph runner, and doctor.
 */
export async function connectDaemon(cwd?: string): Promise<DaemonClient> {
  const info = await readDaemonInfo(cwd ?? process.cwd());
  if (!info) {
    throw new Error(
      `no daemon found. Run ${pc.bold("cco serve")} first, or use ${pc.bold("cco dispatch")} for one-shot mode.`,
    );
  }
  if (!isDaemonAlive(info)) {
    throw new Error(
      `daemon (pid ${info.pid}) is not running. Run ${pc.bold("cco serve")} to restart.`,
    );
  }
  const client = new DaemonClient(info.port, info.token);
  await client.connect();
  return client;
}
