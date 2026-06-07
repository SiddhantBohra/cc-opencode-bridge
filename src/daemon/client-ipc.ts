import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { IpcRequest, IpcResponse } from "./ipc.js";

/**
 * CLI-side IPC client. Connects to the daemon's Unix socket,
 * sends one request, reads one or more responses, disconnects.
 */
export class DaemonClient {
  private socket!: Socket;

  constructor(private socketPath: string) {}

  /** Connect to the daemon socket. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = connect(this.socketPath, () => resolve());
      this.socket.on("error", (err) =>
        reject(new Error(`cannot connect to daemon at ${this.socketPath}: ${err.message}`)),
      );
    });
  }

  /**
   * Send a request and return the first non-event response.
   * If the response is an error, throw it.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    const req = { id, method, params } as IpcRequest;
    this.socket.write(JSON.stringify(req) + "\n");

    return new Promise<T>((resolve, reject) => {
      const rl = createInterface({ input: this.socket, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const resp = JSON.parse(line) as IpcResponse;
          if (resp.id !== id) return;
          if ("error" in resp) {
            reject(new Error(resp.error.message));
            rl.close();
          } else if ("result" in resp) {
            resolve(resp.result as T);
            rl.close();
          }
          // "event" responses are ignored by `call` — use `stream` instead.
        } catch { /* parse error — skip */ }
      });
      rl.on("close", () => reject(new Error("daemon disconnected")));
      this.socket.on("error", (err) => reject(err));
    });
  }

  /**
   * Send a request and stream back event responses via a callback.
   * Resolves when the connection closes or a `result` response arrives.
   */
  async stream(
    method: string,
    params: Record<string, unknown>,
    onEvent: (event: unknown) => void,
  ): Promise<unknown> {
    const id = randomUUID();
    const req = { id, method, params } as IpcRequest;
    this.socket.write(JSON.stringify(req) + "\n");

    return new Promise<unknown>((resolve, reject) => {
      const rl = createInterface({ input: this.socket, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const resp = JSON.parse(line) as IpcResponse;
          if (resp.id !== id) return;
          if ("error" in resp) {
            reject(new Error(resp.error.message));
            rl.close();
          } else if ("event" in resp) {
            onEvent(resp.event);
          } else if ("result" in resp) {
            resolve(resp.result);
            rl.close();
          }
        } catch { /* skip */ }
      });
      rl.on("close", () => resolve(undefined));
      this.socket.on("error", (err) => reject(err));
    });
  }

  close(): void {
    try {
      this.socket.end();
    } catch { /* ignore */ }
  }
}
