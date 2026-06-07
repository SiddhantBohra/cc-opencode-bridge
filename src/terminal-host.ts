import { spawn, type ChildProcess } from "node:child_process";

type TerminalRecord = {
  id: string;
  proc: ChildProcess;
  output: string;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  outputByteLimit?: number;
  exitWaiters: Array<(s: { exitCode: number | null; signal: string | null }) => void>;
};

/**
 * Manages real OS terminals on behalf of the agent.
 *
 * When opencode (the agent) wants to run a command, it calls our
 * `createTerminal` / `terminalOutput` / `waitForTerminalExit` etc.
 * methods. We actually spawn the process and surface output back.
 */
export class TerminalHost {
  private terminals = new Map<string, TerminalRecord>();
  private counter = 0;

  create(params: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Array<{ name: string; value: string }>;
    outputByteLimit?: number;
  }): { terminalId: string } {
    const id = `term-${++this.counter}`;
    const envObj = { ...process.env };
    for (const { name, value } of params.env ?? []) envObj[name] = value;

    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd,
      env: envObj,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rec: TerminalRecord = {
      id,
      proc,
      output: "",
      exitStatus: null,
      outputByteLimit: params.outputByteLimit,
      exitWaiters: [],
    };

    const append = (chunk: Buffer) => {
      rec.output += chunk.toString("utf8");
      if (rec.outputByteLimit && rec.output.length > rec.outputByteLimit) {
        rec.output = rec.output.slice(-rec.outputByteLimit);
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);

    proc.on("exit", (code, signal) => {
      rec.exitStatus = { exitCode: code, signal };
      const waiters = rec.exitWaiters.splice(0);
      for (const w of waiters) w(rec.exitStatus);
    });

    this.terminals.set(id, rec);
    return { terminalId: id };
  }

  output(id: string): { output: string; exitStatus: { exitCode: number | null; signal: string | null } | null; truncated: boolean } {
    const rec = this.requireTerm(id);
    return {
      output: rec.output,
      exitStatus: rec.exitStatus ?? null,
      truncated: false,
    };
  }

  async waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const rec = this.requireTerm(id);
    if (rec.exitStatus) return rec.exitStatus;
    return new Promise((resolve) => rec.exitWaiters.push(resolve));
  }

  kill(id: string): void {
    const rec = this.requireTerm(id);
    if (!rec.exitStatus) rec.proc.kill();
  }

  release(id: string): void {
    const rec = this.terminals.get(id);
    if (!rec) return;
    if (!rec.exitStatus) rec.proc.kill();
    this.terminals.delete(id);
  }

  releaseAll(): void {
    for (const id of [...this.terminals.keys()]) this.release(id);
  }

  private requireTerm(id: string): TerminalRecord {
    const rec = this.terminals.get(id);
    if (!rec) throw new Error(`Unknown terminal: ${id}`);
    return rec;
  }
}
