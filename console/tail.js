"use strict";

const fs = require("fs");

const SMALL_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB
const TAIL_CHUNK_BYTES = 256 * 1024; // 256KB, generous for ~50 JSON lines

// Return the last `maxLines` lines of a (possibly large) file without ever
// reading the whole thing into memory when it's big. For files under the
// threshold, just read+split -- simplest correct approach. For bigger
// files, read only the last chunk of bytes and split on newlines
// (discarding a possibly-partial first line from the chunk boundary).
function tailLines(filePath, maxLines) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return [];
  }

  if (stat.size === 0) return [];

  if (stat.size <= SMALL_FILE_THRESHOLD) {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    return lines.slice(-maxLines);
  }

  const readLength = Math.min(TAIL_CHUNK_BYTES, stat.size);
  const start = stat.size - readLength;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(readLength);
    fs.readSync(fd, buf, 0, readLength, start);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    // Drop the first line if we started mid-file, since it's likely
    // truncated (we started reading at an arbitrary byte offset, not a
    // line boundary).
    if (start > 0 && lines.length > 1) {
      lines.shift();
    }
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { tailLines };
