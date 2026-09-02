#!/usr/bin/env node
// Instant, read-only progress table for a Liberta session.
// Usage: _status.mjs [<session-id>] [--all]
//   with no id, uses index.json's active_session_id.
//   --all lists every session in index.json, one line each, and ignores
//   the per-session detail view.
//
// READ-ONLY, NON-NEGOTIABLE: this script only opens files for reading. It
// must never create, write, rename, chmod or delete anything under
// ~/.claude/liberta-runs/ -- not even a cache, a lock file, or an
// events.jsonl line recording that status was viewed. There is a LIVE run
// in that store whose controller drains it every wake; a write here would
// corrupt it. Do not add fs.writeFileSync/appendFileSync/mkdirSync/etc to
// this file.
//
// DEGRADE GRACEFULLY, never a stack trace: a nonexistent session id prints
// a clear one-line message and exits non-zero; a missing plan.json/
// state.json/events.jsonl/inbox prints "no plan yet" / "no events" /
// "0 pending" and exits 0; an unparseable file is reported as unreadable
// (distinct from simply absent) and everything else is still printed.
// Wrap the whole body so no raw exception ever reaches the user.
//
// PERFORMANCE: meant to feel instant. Reads only what it needs -- events
// are tailed from the end of the file rather than the whole file being
// parsed when it is large -- no sleeps, no network, no child processes.

import fs from "fs";
import path from "path";
import { runsRoot } from "./_store.mjs";

// --- safe, read-only file helpers -----------------------------------

// Returns { exists, ok, value, reason }.
//   exists=false             -> ENOENT: the file is simply absent.
//   exists=true, ok=false    -> present but unreadable/unparseable/wrong
//                                shape; `reason` explains why. NEVER
//                                laundered into "absent" or "empty".
//   exists=true, ok=true     -> `value` is the parsed JSON.
function readJsonSafe(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { exists: false, ok: false, value: undefined, reason: null };
    }
    return {
      exists: true,
      ok: false,
      value: undefined,
      reason: `could not read it (${err && err.code ? err.code : err})`,
    };
  }
  if (!raw.trim()) {
    return { exists: true, ok: false, value: undefined, reason: "file is empty" };
  }
  try {
    return { exists: true, ok: true, value: JSON.parse(raw), reason: null };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      value: undefined,
      reason: `not valid JSON (${err.message})`,
    };
  }
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// Tail the last N JSON lines of a file without reading the whole thing
// into memory for huge files. Reads at most `chunk` bytes from the end,
// growing once if that didn't contain enough newlines. Never throws.
function tailJsonLines(filePath, n) {
  const st = statSafe(filePath);
  if (!st) return { exists: false, ok: true, lines: [], badLines: 0 };
  if (st.size === 0) return { exists: true, ok: true, lines: [], badLines: 0 };

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (err) {
    return {
      exists: true,
      ok: false,
      reason: `could not open it (${err && err.code ? err.code : err})`,
      lines: [],
      badLines: 0,
    };
  }

  try {
    let chunkSize = 8192;
    let text = "";
    let rawLines = [];
    // Grow the read window until we have n+1 newline-delimited pieces or
    // we've read the whole file.
    while (true) {
      const readSize = Math.min(chunkSize, st.size);
      const start = st.size - readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, start);
      text = buf.toString("utf8");
      rawLines = text.split("\n").filter((l) => l.trim().length > 0);
      if (rawLines.length > n || readSize >= st.size) break;
      chunkSize *= 4;
    }
    const tail = rawLines.slice(-n);
    const lines = [];
    let badLines = 0;
    for (const l of tail) {
      try {
        lines.push(JSON.parse(l));
      } catch {
        badLines += 1;
      }
    }
    return { exists: true, ok: true, lines, badLines };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      reason: `could not read it (${err && err.code ? err.code : err})`,
      lines: [],
      badLines: 0,
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function countInboxPending(sessionDir) {
  const dir = path.join(sessionDir, "inbox");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, count: 0 };
    return { ok: false, count: 0, reason: `could not read inbox (${err && err.code ? err.code : err})` };
  }
  let count = 0;
  for (const e of entries) {
    if (e.name === "archive") continue;
    if (!e.isFile()) continue;
    count += 1;
  }
  return { ok: true, count };
}

// --- small formatting helpers ----------------------------------------

function pad(str, width) {
  str = String(str);
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}

function truncate(str, max) {
  str = String(str);
  if (str.length <= max) return str;
  if (max <= 3) return str.slice(0, max);
  return str.slice(0, max - 3) + "...";
}

function firstClause(str) {
  if (!str) return "";
  const s = String(str).split("\n")[0];
  const m = s.match(/^[^.!?]*[.!?]?/);
  return (m ? m[0] : s).trim();
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const out = [];
  out.push(headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd());
  for (const r of rows) {
    out.push(r.map((c, i) => pad(String(c ?? ""), widths[i])).join("  ").trimEnd());
  }
  return out.join("\n");
}

function fmtDeadline(iso) {
  if (!iso) return "(none)";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return `${iso} (unparseable)`;
  const now = Date.now();
  return t < now ? `${iso} (PASSED)` : iso;
}

// --- session detail view ----------------------------------------------

function printSessionStatus(sessionId, lines) {
  const root = runsRoot();
  const sessionDir = path.join(root, sessionId);
  const sessionSt = statSafe(sessionDir);

  if (!sessionSt || !sessionSt.isDirectory()) {
    lines.push(`no such session: ${sessionId}`);
    lines.push("(try: node scripts/_status.mjs --all)");
    return 1;
  }

  const indexPath = path.join(root, "index.json");
  const indexRead = readJsonSafe(indexPath);
  let indexEntry = null;
  if (indexRead.exists && indexRead.ok) {
    const idx = indexRead.value;
    if (idx && Array.isArray(idx.sessions)) {
      indexEntry = idx.sessions.find((s) => s && s.id === sessionId) || null;
    }
  }

  const statePath = path.join(sessionDir, "state.json");
  const stateRead = readJsonSafe(statePath);
  const state =
    stateRead.exists && stateRead.ok ? stateRead.value : {};

  const planPath = path.join(sessionDir, "plan.json");
  const planRead = readJsonSafe(planPath);
  let tasks = [];
  let planNote = null;
  if (!planRead.exists) {
    planNote = "no plan yet";
  } else if (!planRead.ok) {
    planNote = `plan.json unreadable: ${planRead.reason}`;
  } else {
    const plan = planRead.value;
    if (plan && Array.isArray(plan.tasks)) {
      tasks = plan.tasks;
    } else {
      planNote = "plan.json has no tasks yet";
    }
  }

  // ---- header ----
  lines.push(`session:   ${sessionId}`);
  lines.push(`status:    ${state.status ?? indexEntry?.status ?? "(unknown)"}`);
  lines.push(`profile:   ${state.profile ?? "(unknown)"}`);
  lines.push(
    `iteration: ${state.iteration ?? "?"}/${state.max_iterations ?? "?"}`
  );
  lines.push(
    `tokens:    ${state.tokens_spent ?? "?"}/${state.max_tokens ?? "?"}`
  );
  lines.push(`deadline:  ${fmtDeadline(state.wall_deadline)}`);
  lines.push(
    `branch:    ${state.run_branch ?? "(unknown)"}  project: ${
      indexEntry?.project_path ?? "(unknown)"
    }`
  );
  if (stateRead.exists && !stateRead.ok) {
    lines.push(`  (note: state.json unreadable: ${stateRead.reason})`);
  }
  lines.push("");

  // ---- per-task table ----
  if (planNote) {
    lines.push(planNote);
  } else if (tasks.length === 0) {
    lines.push("no tasks yet");
  } else {
    const headers = ["ID", "W", "ROLE", "STATUS", "PASS", "ATT", "SUMMARY"];
    const rows = tasks.map((t) => {
      const summary = truncate(
        t.title || firstClause(t.description) || "",
        60
      );
      return [
        t.id ?? "?",
        t.wave ?? "?",
        t.role ?? "?",
        t.status ?? "?",
        t.passing === true ? "yes" : t.passing === false ? "no" : "-",
        t.attempts ?? 0,
        summary,
      ];
    });
    lines.push(renderTable(headers, rows));
    lines.push("");

    // ---- rollup ----
    let done = 0,
      pending = 0,
      blocked = 0,
      failed = 0,
      other = 0;
    const byWave = new Map();
    for (const t of tasks) {
      const status = t.status ?? "unknown";
      if (status === "done") done += 1;
      else if (status === "pending") pending += 1;
      else if (status === "blocked") blocked += 1;
      else if (status === "failed") failed += 1;
      else other += 1;

      const w = t.wave ?? "?";
      if (!byWave.has(w)) byWave.set(w, [0, 0]);
      const entry = byWave.get(w);
      entry[1] += 1;
      if (status === "done") entry[0] += 1;
    }
    lines.push(
      `TOTAL ${tasks.length}  done=${done}  pending=${pending}  blocked=${blocked}  failed=${failed}` +
        (other ? `  other=${other}` : "")
    );
    const waveKeys = [...byWave.keys()].sort((a, b) => {
      const na = Number(a),
        nb = Number(b);
      if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b));
      return na - nb;
    });
    const perWave = waveKeys
      .map((w) => {
        const [d, total] = byWave.get(w);
        return `w${w}:${d}/${total}`;
      })
      .join(" ");
    lines.push(`per-wave: ${perWave}`);
  }
  lines.push("");

  // ---- inbox pending count ----
  const inbox = countInboxPending(sessionDir);
  if (!inbox.ok) {
    lines.push(`inbox: unreadable (${inbox.reason})`);
  } else {
    lines.push(`inbox: ${inbox.count} pending`);
  }
  lines.push("");

  // ---- recent events ----
  const eventsPath = path.join(sessionDir, "events.jsonl");
  const tail = tailJsonLines(eventsPath, 5);
  if (!tail.exists) {
    lines.push("no events");
  } else if (!tail.ok) {
    lines.push(`events.jsonl unreadable: ${tail.reason}`);
  } else if (tail.lines.length === 0) {
    lines.push("no events");
  } else {
    lines.push("RECENT EVENTS:");
    for (const e of tail.lines) {
      const ts = e.ts ?? "?";
      const type = e.type ?? "?";
      const summary = truncate(e.summary ?? "", 90);
      lines.push(`  ${ts}  ${type}  ${summary}`);
    }
    if (tail.badLines > 0) {
      lines.push(`  (${tail.badLines} unreadable event line(s) skipped)`);
    }
  }

  return 0;
}

// --- --all view ---------------------------------------------------------

function printAllSessions(lines) {
  const root = runsRoot();
  const indexPath = path.join(root, "index.json");
  const read = readJsonSafe(indexPath);

  if (!read.exists) {
    lines.push("no sessions: index.json not found");
    return 0;
  }
  if (!read.ok) {
    lines.push(`index.json unreadable: ${read.reason}`);
    return 1;
  }
  const idx = read.value;
  if (!idx || !Array.isArray(idx.sessions) || idx.sessions.length === 0) {
    lines.push("no sessions registered");
    return 0;
  }

  const activeId = idx.active_session_id;
  const rows = idx.sessions.map((s) => {
    const id = s && s.id ? s.id : "(unknown)";
    const active = id === activeId ? "*" : " ";
    const status = s && s.status ? s.status : "(unknown)";

    let rollup = "";
    const planRead = readJsonSafe(path.join(root, id, "plan.json"));
    if (planRead.exists && planRead.ok && planRead.value && Array.isArray(planRead.value.tasks)) {
      const tasks = planRead.value.tasks;
      const done = tasks.filter((t) => t.status === "done").length;
      rollup = `${done}/${tasks.length} tasks`;
    }

    return [active, id, status, rollup];
  });

  lines.push("ALL SESSIONS:");
  lines.push(renderTable(["", "ID", "STATUS", "TASKS"], rows));
  return 0;
}

// --- entry point --------------------------------------------------------

function parseArgs(argv) {
  let all = false;
  let sessionId = null;
  for (const a of argv) {
    if (a === "--all") all = true;
    else if (!sessionId) sessionId = a;
  }
  return { all, sessionId };
}

function main() {
  const lines = [];
  let exitCode = 0;
  try {
    const { all, sessionId } = parseArgs(process.argv.slice(2));

    if (all) {
      exitCode = printAllSessions(lines);
    } else {
      let id = sessionId;
      if (!id) {
        const indexRead = readJsonSafe(path.join(runsRoot(), "index.json"));
        if (indexRead.exists && indexRead.ok && indexRead.value) {
          id = indexRead.value.active_session_id;
        }
        if (!id) {
          lines.push(
            "no active session (index.json has no active_session_id) - pass a session id, or use --all"
          );
          process.stdout.write(lines.join("\n") + "\n");
          process.exit(1);
        }
      }
      exitCode = printSessionStatus(id, lines);
    }
  } catch (err) {
    // Belt-and-braces: no raw exception should ever reach the user.
    lines.push(`_status: internal error: ${err && err.message ? err.message : err}`);
    exitCode = 1;
  }

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(exitCode);
}

main();
