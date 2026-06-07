# cc-opencode-bridge

**ACP-native dispatch from Claude Code to opencode.** Claude Code hands work off to opencode over the Agent Client Protocol; opencode streams every thought, tool call, file edit, and terminal command back in real time over the same channel. No MCP, no HTTP server, no glue scripts — one binary, one JSON-RPC link over stdio.

```
┌───────────────┐                       ┌──────────────────┐                       ┌────────────┐
│  Claude Code  │ ── Bash: cco dispatch │  cc-opencode-    │ ── ACP JSON-RPC ───── │  opencode  │
│  (or any      │ ───────────────────▶  │  bridge (Node)   │ ◀── over stdio ────── │   acp      │
│   shell)      │                       │                  │   (NDJSON)            │            │
└───────────────┘                       └──────────────────┘                       └────────────┘
                                                │
                                                └─▶ pretty event stream to stdout
                                                └─▶ full JSONL event log to disk
```

---

## Why this exists

You're driving a task in Claude Code and you want a second coding agent — opencode — to do the actual implementation, while Claude Code stays in the loop with full real-time visibility. The naive options:

- **Shell out to `opencode run`** — works, but it's one-shot text. No mid-task feedback, no session resumption, no structured events.
- **MCP server inside opencode** — couples opencode to a specific transport and reverses the orchestration direction. You wanted Claude Code on top.
- **Wrap a whole platform** like claw-orchestrator — comprehensive, but you inherit all of its abstractions.

`cc-opencode-bridge` does exactly one thing: speaks **ACP** (the canonical agent-to-agent protocol from Zed Industries) to opencode's `acp` server, and exposes it as a CLI that Claude Code can call via Bash. Every tool call opencode makes (write file, run command, request permission) round-trips through this bridge in real time.

## Install

```bash
git clone https://github.com/<you>/cc-opencode-bridge
cd cc-opencode-bridge
npm install
npm run build
npm link        # exposes `cco` globally
```

Prerequisites: Node 20+, [`opencode`](https://github.com/sst/opencode) v1.15.3 or later on `PATH`.

## Use

### One-shot dispatch

```bash
cco dispatch "Add a /healthz endpoint that returns 200 OK with the git sha" --cwd ./my-app
```

Claude Code can invoke that via Bash and get the full event stream back as stdout. Add `-q` for a quiet run (events only in the JSONL log).

### Resume a session

```bash
cco dispatch "Now write a test for it" --cwd ./my-app --resume ses_15d7be879ffeQ1tt3Y0R6N0Owj
```

The session ID is printed at the end of every dispatch (and recorded in the JSONL log).

### Replay or live-tail an event log

```bash
cco tail .cco/events-2026-06-07T14-37-28-824Z.jsonl       # replay
cco tail .cco/events-2026-06-07T14-37-28-824Z.jsonl -f    # follow live
```

Useful when Claude Code dispatches in one terminal and you want to watch from another, or to post-mortem a dispatch from its log.

## CLI

```
cco dispatch <task> [options]
  -d, --cwd <dir>             working directory for the agent (default: cwd)
  -a, --agent <cmd>           agent binary (default: opencode)
      --agent-arg <arg...>    extra args appended after `acp`
  -p, --permission <mode>     auto | interactive | deny (default: auto)
  -l, --log <path>            JSONL event log (default: ./.cco/events-<ts>.jsonl)
  -r, --resume <sessionId>    resume an existing session
  -q, --quiet                 suppress pretty output (events only in JSONL log)
  -v, --verbose               include raw tool inputs/outputs in pretty output
      --stderr                inherit opencode's stderr (debug the agent)

cco tail <path> [-f|--follow]
```

## How the bridge works

The bridge is a [`ClientSideConnection`](https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html) from the official `@agentclientprotocol/sdk`. On every `dispatch` it:

1. Spawns `opencode acp` as a subprocess with piped stdio.
2. Converts the child's stdin/stdout to Web Streams and wraps them with `ndJsonStream`.
3. Performs the ACP `initialize` handshake, advertising **client** capabilities: `fs.readTextFile`, `fs.writeTextFile`, `terminal`.
4. Calls `session/new` (or `session/resume`/`session/load` when `--resume` is given) and then `session/prompt` with the task.
5. Implements the full **client side** of ACP so opencode can call back into the bridge:

   | ACP method | Bridge behavior |
   | --- | --- |
   | `session/update` | Pretty-print to stdout + append to JSONL log |
   | `session/request_permission` | Auto / interactive / deny per `--permission` |
   | `fs/read_text_file` | Read from local filesystem (relative to `--cwd`) |
   | `fs/write_text_file` | Write to local filesystem (creates dirs) |
   | `terminal/create` | Spawn a real child process (Node `child_process.spawn`) |
   | `terminal/output` | Return buffered output + exit status |
   | `terminal/wait_for_exit` | Resolve when the process exits |
   | `terminal/kill` / `release` | Signal and cleanup |

6. Awaits the `session/prompt` response and exits with `0` on `end_turn`, `2` otherwise.

### What gets logged

Every event observed during a dispatch is appended to a JSONL file:

```jsonl
{"ts":"…","kind":"dispatch_start","data":{"cwd":"…","task":"…"}}
{"ts":"…","kind":"initialize","data":{"protocolVersion":1,"agentCapabilities":{…}}}
{"ts":"…","kind":"session_ready","data":{"sessionId":"ses_…"}}
{"ts":"…","kind":"session_update","data":{"sessionId":"…","update":{"sessionUpdate":"tool_call","title":"write",…}}}
{"ts":"…","kind":"fs_write","data":{"path":"…","bytes":47}}
{"ts":"…","kind":"terminal_create","data":{"command":"bash","args":["-c","python3 calc.py"]}}
{"ts":"…","kind":"session_update","data":{"sessionId":"…","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done. "}}}}
{"ts":"…","kind":"prompt_complete","data":{"sessionId":"…","stopReason":"end_turn"}}
```

This file is a complete machine-readable transcript of the dispatch — replayable with `cco tail`, ingestible by other tools.

## Calling from Claude Code

The intended flow:

```text
User → Claude Code → Bash("cco dispatch '<task>' --cwd /work")
                       ↓
                     bridge → opencode (ACP)
                       ↓
                     stream events back to Claude Code's tool output
                       ↓
                     Claude Code reads the final summary + diff and reports
```

For background dispatch (let opencode chew on a long task while Claude Code continues other work):

```bash
cco dispatch "<task>" --cwd /work --quiet > /tmp/dispatch.log 2>&1 &
# later — read the JSONL log or tail it
cco tail /tmp/dispatch.log -f
```

## Differences from prior art

| Project | Direction | Transport | Notes |
| --- | --- | --- | --- |
| `opencode run` | Claude Code → opencode | stdio (one-shot text) | No streaming, no resume, no callbacks |
| `acp-claude-code` | Zed → Claude Code | ACP | Wraps Claude Code *as* an ACP agent (opposite direction) |
| `acpx` | CLI → any ACP agent | ACP | General-purpose CLI; this project focuses on the Claude-Code-driving-opencode flow |
| `claw-orchestrator` | Editor → many agents | Custom runtime | Full platform: dashboard, council, autoloop |
| **`cc-opencode-bridge`** | **Claude Code → opencode** | **ACP** | **One bridge, fully ACP-native, with the client side completely implemented** |

## Roadmap

- `cco serve` — long-running daemon with HTTP control plane and SSE event stream
- Council mode: parallel dispatches in isolated git worktrees with vote-based merge
- Bidirectional handoff: opencode pauses → asks Claude Code a question → resumes on answer
- Wrap other ACP-compatible agents (Gemini CLI, Codex) behind the same `cco dispatch` UX

## License

MIT
