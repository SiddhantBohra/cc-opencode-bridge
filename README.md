# cc-opencode-bridge

**ACP-native bidirectional bridge from Claude Code to opencode.** One long-lived daemon keeps opencode alive across unlimited turns. Claude Code sends tasks, follow-ups, and answers; opencode streams thoughts, tool calls, file edits, and questions back — all over the Agent Client Protocol, all in real time, with zero MCP.

```
┌───────────────┐   cco start/say/   ┌──────────────────┐   ACP JSON-RPC    ┌──────────────┐
│  Claude Code  │──  answer/cancel ─▶│  cc-opencode-    │──  over stdio  ──▶│  opencode    │
│  (Bash calls) │◀── wait/events ───│  bridge daemon   │◀── (NDJSON)  ────│   acp        │
└───────────────┘   (Unix socket)    └──────────────────┘                   └──────────────┘
                                              │
                                              ├─▶ JSONL event log per session
                                              └─▶ .cco/daemon.sock (IPC)
```

---

## What's different

| Feature | `opencode run` | `acpx` | `claw-orchestrator` | **`cc-opencode-bridge`** |
| --- | --- | --- | --- | --- |
| Bidirectional dialog | No | Partial | Yes (custom runtime) | **Yes (ACP-native)** |
| Session persistence | No | No | Yes | **Yes (resume across turns)** |
| Mid-task questions | No | No | N/A | **Yes (request_permission ↔ cco answer)** |
| Realtime event stream | No | Yes | Yes (dashboard) | **Yes (JSONL + cco events)** |
| Cancellation | Ctrl-C | Yes | Yes | **Yes (cco cancel → session/cancel)** |
| One process, many turns | No (spawn per call) | No | Yes | **Yes (daemon keeps opencode alive)** |
| Claude-Code-friendly | 7/10 | 6/10 | 4/10 | **10/10 (exit codes, JSON output)** |
| Transport | stdio (one-shot) | stdio | HTTP/WS | **ACP over stdio (spec-compliant)** |
| Official SDK | No | No | No | **Yes (@agentclientprotocol/sdk)** |

## Install

```bash
git clone https://github.com/SiddhantBohra/cc-opencode-bridge
cd cc-opencode-bridge
npm install
npm run build
npm link        # exposes `cco` globally
```

Prerequisites: Node 20+, [`opencode`](https://github.com/sst/opencode) v1.15+ on `PATH`.

---

## Quick start

### One-shot dispatch (no daemon)

```bash
cco dispatch "Add a /healthz endpoint" --cwd ./my-app
```

### Daemon mode (multi-turn, bidirectional)

```bash
# Terminal 1: start the daemon
cco serve --cwd ./my-app

# Terminal 2 (or from Claude Code via Bash):
SID=$(cco start "Refactor auth.ts to use bcrypt" --cwd ./my-app | jq -r .sessionId)
cco wait $SID --cwd ./my-app        # blocks until done or question
# exit 0 = done, 10 = question, 11 = cancelled

# Send a follow-up (reuses same session, same opencode process)
cco say $SID "Now write tests for it" --cwd ./my-app
cco wait $SID --cwd ./my-app

# Watch events live from another terminal
cco events $SID --follow --cwd ./my-app
```

### Answering questions from opencode

When opencode needs permission (e.g., to run a command), it pauses and asks. `cco wait` returns exit code `10` with the question details:

```bash
cco wait $SID --cwd ./my-app --quiet
# Output: {"reason":"question","sessionId":"ses_...","question":{"requestId":"q_42","title":"Run npm install?","options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},...]}}

# Answer it:
cco answer q_42 allow_once --cwd ./my-app

# Then wait for the turn to finish:
cco wait $SID --cwd ./my-app
```

---

## CLI reference

### Daemon lifecycle

| Command | Purpose |
| --- | --- |
| `cco serve [--cwd] [--agent] [--stderr]` | Start the daemon (keeps opencode alive) |
| `cco stop [--cwd]` | Shut down the daemon |
| `cco status [--cwd] [--json]` | Show daemon info + active sessions |

### Session control

| Command | Purpose |
| --- | --- |
| `cco start <task> [--cwd]` | Create session, send first task, return `{sessionId}` |
| `cco say <sid> <text> [--cwd]` | Send follow-up to an idle session |
| `cco wait <sid> [--cwd] [-t ms] [-q]` | Block until turn ends, question, cancel, or timeout |
| `cco answer <reqid> <optionId> [--cwd]` | Answer a pending question |
| `cco cancel <sid> [--cwd]` | Cancel an in-progress turn |
| `cco end <sid> [--cwd]` | Close session, free resources |
| `cco events <sid> [--cwd] [-f] [-s seq] [--json]` | Stream/replay events |
| `cco sessions [--cwd] [--json]` | List all known sessions — works even when the daemon is down |

### Legacy (one-shot, no daemon)

| Command | Purpose |
| --- | --- |
| `cco dispatch <task> [--cwd] [-r sid] [-q] [-v]` | Spawn opencode, run one turn, exit |
| `cco tail <path> [-f]` | Replay a JSONL log file |

### Exit codes for `cco wait`

| Code | Meaning |
| --- | --- |
| `0` | Turn completed (`end_turn`) |
| `10` | Question pending — answer with `cco answer` |
| `11` | Turn was cancelled |
| `12` | Error |
| `13` | Timeout |

---

## How Claude Code should use this

The intended orchestration pattern from Claude Code:

```bash
# Bootstrap (once per project)
cco serve --cwd /work &

# Dispatch a task
SID=$(cco start "Implement the auth module" --cwd /work | jq -r .sessionId)

# Wait loop: handle turns, questions, follow-ups
while true; do
  cco wait $SID --cwd /work --quiet > /tmp/wait.json 2>&1
  RC=$?

  if [ $RC -eq 0 ]; then
    # Turn complete — read events, summarize, done
    break
  elif [ $RC -eq 10 ]; then
    # Question from opencode
    REQID=$(jq -r .question.requestId /tmp/wait.json)
    TITLE=$(jq -r .question.title /tmp/wait.json)
    # Claude Code decides based on the question title
    cco answer $REQID allow_once --cwd /work
  elif [ $RC -eq 11 ]; then
    echo "Cancelled"
    break
  else
    echo "Error"
    break
  fi
done

# Send a follow-up in the same session
cco say $SID "Now add error handling" --cwd /work
cco wait $SID --cwd /work

# Cleanup
cco end $SID --cwd /work
cco stop --cwd /work
```

---

## Architecture

### Daemon mode

```
cco serve
  └─ spawns `opencode acp` (one long-lived subprocess)
  └─ listens on .cco/daemon.sock (Unix domain socket)
  └─ manages N concurrent sessions with per-session state machines:
      idle → running → (awaiting_answer ↔ running)* → idle

cco start/say/answer/cancel/wait/events/end/stop
  └─ connects to .cco/daemon.sock
  └─ sends one JSON-RPC request
  └─ reads response (or streams events for `events --follow`)
  └─ disconnects + exits
```

### ACP client implementation

The daemon implements the full **client side** of the ACP protocol:

| ACP method | Bridge behavior |
| --- | --- |
| `session/update` | Record in session event log + stream to followers |
| `session/request_permission` | Surface as "question" event; block until `cco answer` resolves it |
| `fs/read_text_file` | Read from local filesystem |
| `fs/write_text_file` | Write to local filesystem (creates dirs) |
| `terminal/create` | Spawn real child process |
| `terminal/output` | Return buffered output + exit status |
| `terminal/wait_for_exit` | Block until process exits |
| `terminal/kill` / `release` | Signal and cleanup |

### Multi-agent fan-out

Everything is scoped per `--cwd` — the socket, the registry, the opencode process. Running multiple daemons in different directories gives you N truly parallel opencode instances, with the orchestrator (Claude Code) coordinating across them:

```bash
git worktree add .wt-taskA -b taskA && cco serve --cwd .wt-taskA &
git worktree add .wt-taskB -b taskB && cco serve --cwd .wt-taskB &
# dispatch independently, wait on both, merge results yourself
```

Don't ask one opencode session to multiplex parallel work: concurrent prompts on a single ACP connection are undefined behavior (opencode serializes turns through one global event stream per connection). One daemon = one turn at a time, by design. Sessions on a shared daemon isolate *context* (conversations never leak between sessionIds) but not *execution*. Separate processes buy true parallelism, crash isolation, and — with worktrees — file isolation.

### Key insight from opencode source

opencode's `acp` command stays alive until stdin closes (no idle timeout, no max-turn limit). One subprocess hosts unlimited sessions and turns indefinitely. The daemon keeps stdin open for the life of the process.

opencode's `session/prompt` **always returns `stopReason: "end_turn"`** — cancellation surfaces as a JSON-RPC error on the pending prompt call, not as a different stop reason. The bridge handles this correctly.

### Session persistence

Sessions are recorded in `.cco/sessions.json` (id, first task, turn count, last message, timestamps). The registry survives daemon restarts — `cco sessions` lists past work even with the daemon down. Sending `cco say` to a session the daemon doesn't have in memory triggers an automatic ACP `session/resume`: opencode persists conversations server-side, so the full context (files discussed, decisions made) comes back, even days later in a fresh daemon.

```bash
cco sessions --cwd /work          # what was I working on?
cco say ses_abc123 "continue where we left off" --cwd /work   # auto-resumes
```

### Event log

Every session produces a JSONL event log at `.cco/events-<sessionId>.jsonl`:

```jsonl
{"ts":"...","kind":"turn_start","data":{"turnCount":1,"prompt":"..."}}
{"ts":"...","kind":"session_update","data":{"sessionId":"...","update":{"sessionUpdate":"tool_call",...}}}
{"ts":"...","kind":"question","data":{"requestId":"q_5","title":"Run npm install?","options":[...]}}
{"ts":"...","kind":"answer","data":{"requestId":"q_5","optionId":"allow_once"}}
{"ts":"...","kind":"turn_end","data":{"stopReason":"end_turn"}}
{"ts":"...","kind":"turn_start","data":{"turnCount":2,"prompt":"Now add tests"}}
```

---

## Example

[`examples/password-generator/`](./examples/password-generator/) is a complete artifact of the e2e flow: opencode built a TypeScript CLI (with a 14-test suite) across a 3-turn session, including a human-in-the-loop language decision relayed through Claude Code. [`DEMO.md`](./examples/password-generator/DEMO.md) walks through the full transcript.

## Roadmap

- [ ] `cco serve --detach` — daemonize without holding the terminal
- [ ] Auto-start daemon on first `cco start` if not running
- [ ] Council mode — parallel dispatches in isolated git worktrees with vote-based merge
- [ ] `session/set_mode` support — switch opencode between architect/code/ask modes
- [ ] Web dashboard via `cco serve --http` — SSE event stream + browser UI
- [ ] Multi-agent — wrap Gemini CLI, Codex, and other ACP-compatible agents behind the same `cco` UX
- [ ] `_cco/*` extension methods — Claude Code→opencode sidechannel for mid-turn context injection

## License

MIT
