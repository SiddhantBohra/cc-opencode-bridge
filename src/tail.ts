import { createReadStream, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import pc from "picocolors";
import { StreamRenderer } from "./renderer.js";

export async function tailLog(path: string, opts: { follow?: boolean }): Promise<void> {
  const renderer = new StreamRenderer();

  let offset = 0;

  const drain = async (): Promise<void> => {
    const st = await stat(path).catch(() => null);
    if (!st) return;
    if (st.size <= offset) return;
    const stream = createReadStream(path, { start: offset, encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      offset += Buffer.byteLength(line + "\n", "utf8");
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.kind === "session_update") {
          renderer.handle(entry.data);
        } else {
          process.stdout.write(pc.dim(`[${entry.kind}] `) + summarize(entry.data) + "\n");
        }
      } catch {
        process.stdout.write(pc.red(`[bad line] ${line}\n`));
      }
    }
  };

  await drain();
  if (!opts.follow) return;

  const watcher = watch(path, () => {
    drain().catch((e) => process.stderr.write(pc.red(`tail error: ${(e as Error).message}\n`)));
  });
  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
  // Keep alive
  await new Promise(() => {});
}

function summarize(d: unknown): string {
  try {
    const s = JSON.stringify(d);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(d);
  }
}
