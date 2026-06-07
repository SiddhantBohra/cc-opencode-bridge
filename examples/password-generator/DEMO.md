# End-to-end demo: password generator

Everything in this directory was **built by opencode**, dispatched and orchestrated from Claude Code through `cco` — including the human-in-the-loop decision and the follow-up turn. The orchestrator (Claude Code) never wrote a line of this code; it dispatched, relayed one question to the human, verified the results, and reported back.

## The session transcript

**One session, three turns, one daemon, one opencode process.**

### Turn 1 — dispatch with a deliberate ambiguity

```bash
cco serve --cwd ~/cco-e2e-demo &
SID=$(cco start "Build a password generator CLI tool. Requirements: configurable \
length (default 16), flags for including/excluding symbols and digits, --count \
flag, cryptographically secure random source. I have not told you which \
programming language to use — ask me first." --cwd ~/cco-e2e-demo | jq -r .sessionId)

cco wait $SID --cwd ~/cco-e2e-demo --stream
```

opencode ended its turn with a question, carried up through `lastMessage`:

> **What programming language should I use for the password generator?**

### HITL — the question round-trips to the human

Claude Code relayed the question to the human via AskUserQuestion
(options: Python / Node.js / Go / Rust). The human chose **Node.js / TypeScript**.

### Turn 2 — the answer flows back down, opencode builds

```bash
cco say $SID "Node.js with TypeScript please. Use crypto.randomInt..." --cwd ~/cco-e2e-demo
cco wait $SID --cwd ~/cco-e2e-demo --stream
```

Streamed live through the orchestrator's output: opencode's plan (4 todos),
`package.json` + `tsconfig.json` + `src/index.ts` written, `npm install`,
and four verification runs (default, `--length 24 --count 3`,
`--no-symbols --no-digits`, `--help`).

### Turn 3 — follow-up in the same session

```bash
cco say $SID "Add unit tests using node:test (no new deps). Refactor for \
testability. Run them and make sure they pass." --cwd ~/cco-e2e-demo
cco wait $SID --cwd ~/cco-e2e-demo --stream
```

opencode refactored `src/index.ts` to export testable functions, wrote
`src/index.test.ts` with 14 tests, ran them: **14/14 pass**.

### Verification (by the orchestrator, independently)

```bash
npx tsx src/index.ts --length 20 --count 3   # → 3 random 20-char passwords
npx tsx --test src/index.test.ts             # → tests 14, pass 14, fail 0
```

### Session registry afterwards

```
$ cco sessions --cwd ~/cco-e2e-demo
ses_15d20f05bffeXQqq36gZlMSji2  active  turns=3
  task: Build a password generator CLI tool...
  last: All 14 tests pass and the CLI still works...
```

## Run it yourself

```bash
cd examples/password-generator
npm install
npx tsx src/index.ts --length 24 --count 5
npx tsx --test src/index.test.ts
```
