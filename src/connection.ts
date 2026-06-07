import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { BridgeClient } from "./client.js";

export type ConnectionOptions = {
  /** Path/command to launch the agent. Default: `opencode`. */
  agentCommand?: string;
  /** Extra args appended after `acp`. */
  agentArgs?: string[];
  /** Working directory for the agent subprocess. */
  cwd: string;
  /** Pre-built client implementation (handles incoming agent->client calls). */
  client: BridgeClient;
  /** If set, agent stderr is mirrored to this fd; otherwise discarded. */
  inheritStderr?: boolean;
};

export type ActiveConnection = {
  connection: ClientSideConnection;
  initResult: InitializeResponse;
  child: ChildProcessWithoutNullStreams;
  close: () => Promise<void>;
};

/**
 * Spawn `opencode acp` as a subprocess and establish an ACP client connection
 * over its stdio. Performs the initialize handshake before returning.
 */
export async function connectToOpencodeAgent(opts: ConnectionOptions): Promise<ActiveConnection> {
  const cmd = opts.agentCommand ?? "opencode";
  const args = ["acp", ...(opts.agentArgs ?? [])];

  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", opts.inheritStderr ? "inherit" : "pipe"],
  }) as ChildProcessWithoutNullStreams;

  // Surface a clear error if the child can't be spawned.
  child.on("error", (err) => {
    throw new Error(`Failed to launch '${cmd} acp': ${err.message}`);
  });

  // The official ACP SDK uses Web Streams. Convert from Node streams.
  // Note: ndJsonStream signature is (writable, readable). The "writable"
  // side is where we *write to* the agent (i.e. agent's stdin), and the
  // "readable" side is where we *read from* the agent (i.e. agent's stdout).
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writable, readable);

  const connection = new ClientSideConnection(() => opts.client, stream);

  const initResult = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    },
  });

  const close = async (): Promise<void> => {
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    }
  };

  return { connection, initResult, child, close };
}

export type DispatchTurn = {
  sessionId: string;
  result: PromptResponse;
};

export async function newSession(conn: ClientSideConnection, cwd: string): Promise<NewSessionResponse> {
  return conn.newSession({ cwd, mcpServers: [] });
}
