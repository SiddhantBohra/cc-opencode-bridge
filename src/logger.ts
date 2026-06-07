import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export type LogEntry = {
  ts: string;
  kind: string;
  data: unknown;
};

export class JsonlLogger {
  private stream: WriteStream;
  public readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "a" });
  }

  log(kind: string, data: unknown): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      kind,
      data,
    };
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  async close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}
