import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { SessionState } from "./session-state.js";

type SessionSummary = {
  sessionId: string;
  status: string;
  turnCount: number;
};

export class HttpServer {
  private server: Server;
  private port: number;

  constructor(
    port: number,
    private getSession: (id: string) => SessionState | undefined,
    private listSessions: () => SessionSummary[],
  ) {
    this.port = port;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        process.stderr.write(`daemon: http dashboard on http://localhost:${this.port}\n`);
        resolve();
      });
    });
  }

  stop(): void {
    this.server.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      if (path === "/") return this.serveHtml(res);
      if (path === "/api/sessions") return this.serveSessions(res);
      if (path.startsWith("/api/snapshot/")) return this.serveSnapshot(path.slice("/api/snapshot/".length), res);
      if (path.startsWith("/api/events/")) return this.serveEvents(path.slice("/api/events/".length), req, res);

      notFound(res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private serveHtml(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  }

  private serveSessions(res: ServerResponse): void {
    const sessions = this.listSessions();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sessions));
  }

  private serveSnapshot(sid: string, res: ServerResponse): void {
    const sess = this.getSession(sid);
    if (!sess) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session not found" }));
      return;
    }
    const snap = sess.snapshot();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snap));
  }

  private serveEvents(sid: string, req: IncomingMessage, res: ServerResponse): void {
    const sess = this.getSession(sid);
    if (!sess) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session not found" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // Replay all events from the beginning
    const history = sess.eventsSince(-1);
    for (const entry of history) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Follow new events
    const unsub = sess.follow((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    req.on("close", unsub);
    req.on("error", unsub);
  }
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>cco · daemon dashboard</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; height: 100vh; overflow: hidden; }
.sidebar { width: 300px; min-width: 300px; border-right: 1px solid #30363d; display: flex; flex-direction: column; background: #161b22; }
.sidebar h1 { font-size: 14px; font-weight: 600; padding: 12px 16px; border-bottom: 1px solid #30363d; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; }
.sidebar h1 span { color: #58a6ff; }
.session-list { flex: 1; overflow-y: auto; padding: 8px 0; }
.session-item { padding: 8px 16px; cursor: pointer; border-bottom: 1px solid #21262d; transition: background .15s; }
.session-item:hover { background: #1c2128; }
.session-item.active { background: #1f2937; border-left: 3px solid #58a6ff; padding-left: 13px; }
.session-id { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; color: #c9d1d9; word-break: break-all; }
.session-meta { font-size: 11px; color: #8b949e; margin-top: 2px; display: flex; gap: 8px; align-items: center; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
.badge-idle { background: #1b3a2d; color: #3fb950; }
.badge-running { background: #1f3a5f; color: #58a6ff; }
.badge-awaiting_answer { background: #3d2e00; color: #d29922; }
.badge-cancelled { background: #3d1f1f; color: #f85149; }
.badge-closed { background: #21262d; color: #8b949e; }
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.header { padding: 12px 16px; border-bottom: 1px solid #30363d; background: #161b22; display: flex; align-items: center; gap: 12px; min-height: 48px; }
.header .label { font-size: 13px; color: #8b949e; }
.header .value { font-size: 13px; color: #c9d1d9; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
.header .spacer { flex: 1; }
.event-feed { flex: 1; overflow-y: auto; padding: 12px 16px; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; }
.event { margin-bottom: 8px; padding: 8px 10px; border-radius: 6px; border: 1px solid #21262d; background: #0d1117; }
.event .event-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; color: #8b949e; }
.event .event-kind { font-weight: 600; text-transform: uppercase; }
.event .event-ts { color: #484f58; }
.event .event-body { color: #c9d1d9; white-space: pre-wrap; word-break: break-word; }
.event.thought .event-body { color: #8b949e; font-style: italic; }
.event.message .event-body { color: #7ee787; }
.event.tool .event-body { color: #c9d1d9; }
.event.tool .tool-status { display: inline-block; margin-left: 4px; font-size: 10px; }
.tool-status.completed { color: #3fb950; }
.tool-status.running { color: #58a6ff; }
.tool-status.failed { color: #f85149; }
.tool-status.pending { color: #8b949e; }
.empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: #484f58; font-size: 14px; }
.empty-state p { text-align: center; }
.empty-state code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
.token-usage { font-size: 11px; color: #8b949e; padding: 2px 0; }
.token-usage strong { color: #c9d1d9; }
.no-select { color: #484f58; font-style: italic; padding: 16px; text-align: center; }
</style>
</head>
<body>
<div class="sidebar">
  <h1><span>cco</span> sessions</h1>
  <div class="session-list" id="sessionList"></div>
</div>
<div class="main">
  <div class="header" id="header">
    <span class="no-select">Select a session from the sidebar</span>
  </div>
  <div class="event-feed" id="eventFeed">
    <div class="empty-state"><p>Select a session to view live events</p></div>
  </div>
</div>
<script>
const sessionList = document.getElementById("sessionList");
const header = document.getElementById("header");
const eventFeed = document.getElementById("eventFeed");

let selectedSid = null;
let currentEventSource = null;
let currentSnapshotInterval = null;

function badge(status) {
  return '<span class="badge badge-' + status + '">' + status + "</span>";
}

function renderSessionList(sessions) {
  let html = "";
  for (const s of sessions) {
    const active = s.sessionId === selectedSid ? ' active' : '';
    html += '<div class="session-item' + active + '" data-sid="' + s.sessionId + '">';
    html += '<div class="session-id">' + s.sessionId + "</div>";
    html += '<div class="session-meta">' + badge(s.status) + " turns=" + s.turnCount + "</div>";
    html += "</div>";
  }
  sessionList.innerHTML = html;

  // Click handlers
  for (const el of sessionList.querySelectorAll(".session-item")) {
    el.addEventListener("click", function () {
      selectSession(this.dataset.sid);
    });
  }
}

function selectSession(sid) {
  if (sid === selectedSid) return;
  selectedSid = sid;

  // Close previous EventSource + poll
  if (currentEventSource) { currentEventSource.close(); currentEventSource = null; }
  if (currentSnapshotInterval) { clearInterval(currentSnapshotInterval); currentSnapshotInterval = null; }

  // Highlight
  for (const el of sessionList.querySelectorAll(".session-item")) {
    el.classList.toggle("active", el.dataset.sid === sid);
  }

  // Clear feed, show placeholder
  eventFeed.innerHTML = '<div class="empty-state"><p>Waiting for events…</p></div>';

  // Fetch initial snapshot
  fetchSnapshot(sid);

  // Poll snapshot every 3s for header token usage
  currentSnapshotInterval = setInterval(function () { fetchSnapshot(sid); }, 3000);

  // Open SSE
  currentEventSource = new EventSource("/api/events/" + sid);
  currentEventSource.onmessage = function (e) {
    const entry = JSON.parse(e.data);
    appendEvent(entry);
  };
  currentEventSource.onerror = function () {
    // EventSource auto-reconnects; we just show an indicator
  };
}

function fetchSnapshot(sid) {
  fetch("/api/snapshot/" + sid)
    .then(function (r) { return r.json(); })
    .then(function (snap) {
      updateHeader(snap);
    })
    .catch(function () {});
}

function updateHeader(snap) {
  const tokens = snap.tokenUsage;
  let tokenHtml = "";
  if (tokens.used !== undefined) {
    tokenHtml = '<span class="token-usage">context: <strong>' + fmt(tokens.used) + "</strong>";
    if (tokens.size) {
      const pct = Math.round((tokens.used / tokens.size) * 100);
      tokenHtml += " / " + fmt(tokens.size) + " (" + pct + "%)";
    }
    if (tokens.cost) tokenHtml += " · $" + tokens.cost.toFixed(4);
    tokenHtml += "</span>";
  }

  header.innerHTML =
    '<span class="label">session</span>' +
    '<span class="value">' + snap.sessionId + '</span>' +
    badge(snap.status) +
    '<span class="spacer"></span>' +
    '<span class="label">turn</span>' +
    '<span class="value">' + snap.turnCount + '</span>' +
    tokenHtml;
}

function appendEvent(entry) {
  // Remove empty state if present
  if (eventFeed.querySelector(".empty-state")) {
    eventFeed.innerHTML = "";
  }

  const div = document.createElement("div");
  div.className = "event";

  const hdr = document.createElement("div");
  hdr.className = "event-header";
  hdr.innerHTML = '<span class="event-kind">' + entry.kind + '</span> <span class="event-ts">' + entry.ts + "</span>";
  div.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "event-body";

  if (entry.kind === "session_update") {
    const u = entry.data && entry.data.update ? entry.data.update : entry.data;
    if (u.sessionUpdate === "agent_thought_chunk" && u.content && u.content.text) {
      div.classList.add("thought");
      body.textContent = u.content.text;
    } else if (u.sessionUpdate === "agent_message_chunk" && u.content && u.content.text) {
      div.classList.add("message");
      body.textContent = u.content.text;
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      div.classList.add("tool");
      const status = u.status || "pending";
      body.innerHTML = "<strong>" + (u.title || u.toolCallId) + '</strong> <span class="tool-status ' + status + '">' + status + "</span>";
    } else if (u.sessionUpdate === "usage_update") {
      // Token usage shown in header, skip here
      return;
    } else {
      body.textContent = JSON.stringify(entry.data);
    }
  } else if (entry.kind === "turn_start") {
    const d = entry.data || {};
    body.textContent = "turn " + (d.turnCount || "?") + ": " + (d.prompt || "");
  } else if (entry.kind === "turn_end") {
    body.textContent = entry.data && entry.data.stopReason ? "stop: " + entry.data.stopReason : "turn ended";
  } else if (entry.kind === "question") {
    const q = entry.data || {};
    body.innerHTML = "<strong>?</strong> " + (q.title || "permission") + " reqid=" + (q.requestId || "");
  } else if (entry.kind === "answer") {
    body.textContent = "answered: " + (entry.data && entry.data.optionId ? entry.data.optionId : "");
  } else if (entry.kind === "cancel") {
    body.textContent = "cancelled";
  } else {
    body.textContent = entry.data ? JSON.stringify(entry.data) : "";
  }

  div.appendChild(body);
  eventFeed.appendChild(div);
  eventFeed.scrollTop = eventFeed.scrollHeight;
}

function fmt(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// Poll sessions every 2 seconds
function pollSessions() {
  fetch("/api/sessions")
    .then(function (r) { return r.json(); })
    .then(function (sessions) {
      renderSessionList(sessions);
      // Auto-select first session if none selected
      if (!selectedSid && sessions.length > 0) {
        selectSession(sessions[0].sessionId);
      }
    })
    .catch(function () {});
}

pollSessions();
setInterval(pollSessions, 2000);
</script>
</body>
</html>`;
