#!/usr/bin/env node
// Liberta session inbox helper.
// Usage:
//   _mailbox.mjs list <session-id>
//   _mailbox.mjs reply <session-id> <filename> --text "<reply text>"
//   _mailbox.mjs send <session-id> --type steer|question|info --text "<text>"
// list prints a JSON array (oldest first) of pending inbox messages.
// reply appends reply/replied_ts to the message and archives it (idempotent).
// send writes a new timestamp-named message file into the inbox.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { runsRoot } from "./_store.mjs";

function fail(msg) {
  process.stderr.write(`_mailbox: ${msg}\n`);
  process.exit(1);
}

function inboxDir(sessionId) {
  return path.join(runsRoot(), sessionId, "inbox");
}

function archiveDir(sessionId) {
  return path.join(inboxDir(sessionId), "archive");
}

function parseOpts(argv) {
  const positional = [];
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--text" || a === "--type") {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined) fail(`missing value for ${a}`);
      opts[key] = val;
      i += 2;
    } else {
      positional.push(a);
      i += 1;
    }
  }
  return { positional, opts };
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  // Message files carry operator-authored steer/question text: keep them
  // readable/writable by the owner only (not group/world), overriding the
  // process umask.
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function cmdList(sessionId) {
  if (!sessionId) fail("session-id is required");
  const dir = inboxDir(sessionId);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") {
      process.stdout.write("[]\n");
      return;
    }
    fail(`could not read inbox: ${err.message}`);
  }

  const messages = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue; // skips the archive/ subdir
    if (!f.endsWith(".json")) continue;
    const msg = readJson(full, null);
    if (!msg) continue;
    messages.push({ filename: f, ...msg });
  }

  messages.sort((a, b) => {
    const ta = Date.parse(a.ts || "") || 0;
    const tb = Date.parse(b.ts || "") || 0;
    return ta - tb;
  });

  process.stdout.write(JSON.stringify(messages, null, 2) + "\n");
}

function cmdReply(sessionId, filename, text) {
  if (!sessionId) fail("session-id is required");
  if (!filename) fail("filename is required");
  if (text === undefined) fail("--text is required");

  const dir = inboxDir(sessionId);
  const archive = archiveDir(sessionId);
  const srcPath = path.join(dir, filename);
  const archivedPath = path.join(archive, filename);

  if (fs.existsSync(archivedPath) && !fs.existsSync(srcPath)) {
    process.stdout.write(
      `already archived: ${filename} (no-op)\n`
    );
    return;
  }

  let msg;
  try {
    msg = readJson(srcPath, null);
  } catch (err) {
    fail(`could not read message: ${err.message}`);
  }
  if (!msg) {
    fail(`message not found: ${filename}`);
  }

  msg.reply = text;
  msg.replied_ts = new Date().toISOString();

  try {
    fs.mkdirSync(archive, { recursive: true });
    writeJsonAtomic(archivedPath, msg);
    fs.unlinkSync(srcPath);
  } catch (err) {
    fail(`could not archive message: ${err.message}`);
  }

  process.stdout.write(`replied and archived: ${filename}\n`);
}

function cmdSend(sessionId, type, text) {
  if (!sessionId) fail("session-id is required");
  if (!type || !["steer", "question", "info"].includes(type)) {
    fail('--type must be one of steer|question|info');
  }
  if (text === undefined) fail("--text is required");

  const dir = inboxDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString();
  const stamp = ts.replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  const filename = `${stamp}-${type}-${rand}.json`;
  const filePath = path.join(dir, filename);

  const msg = { type, text, ts };
  try {
    writeJsonAtomic(filePath, msg);
  } catch (err) {
    fail(`could not write message: ${err.message}`);
  }

  process.stdout.write(`sent: ${filename}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "list") {
    const { positional } = parseOpts(rest);
    cmdList(positional[0]);
  } else if (sub === "reply") {
    const { positional, opts } = parseOpts(rest);
    cmdReply(positional[0], positional[1], opts.text);
  } else if (sub === "send") {
    const { positional, opts } = parseOpts(rest);
    cmdSend(positional[0], opts.type, opts.text);
  } else {
    fail(
      "usage: list <session-id> | reply <session-id> <filename> --text \"...\" | send <session-id> --type steer|question|info --text \"...\""
    );
  }

  process.exit(0);
}

main();
