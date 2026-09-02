"use strict";

// ---------------------------------------------------------------------
// Knex connection module. The DB here is a queryable *mirror* of the
// file-based Liberta run store (~/.claude/liberta-runs/) -- the harness
// itself (SKILL.md's controller, scripts/wave-exec.js, etc.) keeps
// writing files unchanged and remains the source of truth. sync.js is
// what keeps this DB in sync with those files; this module only owns
// the connection + schema.
// ---------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const Knex = require("knex");

const { runsRoot } = require("../scripts/_store.cjs");

const DB_CLIENT = (process.env.DB_CLIENT || "sqlite3").trim();

// The port the *original* fixed-path default was written for. Only this
// exact combination (no LIBERTA_RUNS_DIR override, port === DEFAULT_PORT)
// keeps the byte-identical legacy path below, so existing installs that
// never set PORT are untouched by this file's per-instance naming.
const DEFAULT_PORT = 4177;

// ---------------------------------------------------------------------
// Where the sqlite mirror file lives. This MUST be scoped to the active
// run store *and* to the port this instance actually bound: two console
// processes are two independent mirrors, never one shared file, unless
// the operator explicitly points them at the same LIBERTA_CONSOLE_DB.
// console/sync.js's reapRuns() deletes any `runs`/`tasks`/`events` rows
// whose subject is absent from the run store currently being synced, so
// two instances sharing one sqlite file -- even when they only share
// LIBERTA_RUNS_DIR and differ by port -- would each reap the other's
// rows out from under it every sync tick (T14 attempt 2's regression).
//
// Resolution order:
//   1. LIBERTA_CONSOLE_DB, if set to a non-empty path, always wins (an
//      explicit override some callers, e.g. T14's tests, rely on) --
//      two instances CAN share a database this way, deliberately, since
//      the operator asked for it by name.
//   2. If LIBERTA_RUNS_DIR is set (a throwaway/test store), the database
//      lives inside a console-data/ subdirectory of that same store root,
//      named after the bound port, so it is exactly as throwaway as the
//      store it mirrors, can never see the operator's rows, AND never
//      collides with a sibling instance that happens to share the same
//      LIBERTA_RUNS_DIR on a different port.
//   3. Otherwise (no LIBERTA_RUNS_DIR): the canonical default port keeps
//      the original fixed path byte-identical for existing installs; any
//      other port (e.g. a manually chosen PORT, or PORT_AUTO landing
//      somewhere else) gets its own port-suffixed file next to it.
// ---------------------------------------------------------------------
function resolveDbFile(port) {
  const dbOverride = process.env.LIBERTA_CONSOLE_DB;
  if (typeof dbOverride === "string" && dbOverride.length > 0) {
    return path.resolve(dbOverride);
  }
  const runsDirOverride = process.env.LIBERTA_RUNS_DIR;
  if (typeof runsDirOverride === "string" && runsDirOverride.length > 0) {
    return path.join(runsRoot(), "console-data", `liberta-${port}.sqlite`);
  }
  if (port === DEFAULT_PORT) {
    return path.join(__dirname, "data", "liberta.sqlite");
  }
  return path.join(__dirname, "data", `liberta-${port}.sqlite`);
}

// ---------------------------------------------------------------------
// `knex` below is a stable Proxy standing in for the real connection,
// which is not created until `initDb(port)` runs. server.js only learns
// its actual bound port after `app.listen` succeeds (LIBERTA_CONSOLE_
// PORT_AUTO may move it up from the requested port), and the sqlite path
// must be a function of THAT port (see resolveDbFile above), so the real
// connection has to be created after the bind, not at require time. This
// module, server.js and sync.js all destructure `knex` off this file at
// require time, long before initDb() runs, so the exported value has to
// be a single object whose identity never changes -- a Proxy that
// forwards every call and property access to whatever `_client` is set
// to once initDb() runs -- rather than a plain variable that would only
// update the binding held by this file, not the copies already destructured
// elsewhere.
// ---------------------------------------------------------------------
let _client = null;
let dbFile = null;

const knex = new Proxy(function knexNotReady() {}, {
  apply(_target, _thisArg, args) {
    if (!_client) {
      throw new Error("db: knex was used before initDb() completed");
    }
    return _client(...args);
  },
  get(_target, prop) {
    if (!_client) {
      throw new Error("db: knex was used before initDb() completed");
    }
    return _client[prop];
  },
});

// ---------------------------------------------------------------------
// Creates the real connection for the given bound port. Must be called
// exactly once, after server.js's app.listen has succeeded, so the port
// baked into the sqlite filename (branches 2 and 3 of resolveDbFile
// above) is the port this process actually ended up on, not the one it
// merely requested.
// ---------------------------------------------------------------------
function initDb(port) {
  if (DB_CLIENT === "pg" || DB_CLIENT === "postgres" || DB_CLIENT === "postgresql") {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL || DATABASE_URL.length === 0) {
      process.stderr.write(
        "FATAL: DB_CLIENT=pg but DATABASE_URL is not set. Refusing to start " +
          "without a Postgres connection string. Set DATABASE_URL (a standard " +
          "postgres:// connection string) and try again.\n"
      );
      process.exit(1);
    }
    _client = Knex({
      client: "pg",
      connection: DATABASE_URL,
    });
  } else if (DB_CLIENT === "sqlite3" || DB_CLIENT === "sqlite") {
    dbFile = resolveDbFile(port);
    const dataDir = path.dirname(dbFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    _client = Knex({
      client: "sqlite3",
      connection: { filename: dbFile },
      useNullAsDefault: true,
    });
  } else {
    process.stderr.write(
      `FATAL: unrecognized DB_CLIENT "${DB_CLIENT}". Expected "sqlite3" or "pg".\n`
    );
    process.exit(1);
  }
  return { dbFile };
}

// ---------------------------------------------------------------------
// Idempotent, raw-SQL "ensure schema" -- creates tables only if they
// don't already exist. Not a full knex migration-files setup; fine for
// this project's current size (see the task spec this was built from).
// ---------------------------------------------------------------------
async function ensureSchema() {
  if (!(await knex.schema.hasTable("runs"))) {
    await knex.schema.createTable("runs", (t) => {
      t.text("id").primary();
      t.text("project_path");
      t.text("status");
      t.text("parent_session_id");
      t.integer("active").defaultTo(0);
      t.timestamp("updated_at");
    });
  }

  // Explicit additive migration for `runs.parent_session_id`. The
  // createTable block above only runs when the table does NOT exist, so a
  // column added there alone would never land on an already-existing
  // console/data/liberta.sqlite (or an existing Postgres database). This
  // check is idempotent and works on both sqlite3 and pg.
  if (
    (await knex.schema.hasTable("runs")) &&
    !(await knex.schema.hasColumn("runs", "parent_session_id"))
  ) {
    await knex.schema.alterTable("runs", (t) => {
      t.text("parent_session_id");
    });
  }

  if (!(await knex.schema.hasTable("tasks"))) {
    await knex.schema.createTable("tasks", (t) => {
      t.increments("id").primary();
      t.text("run_id").references("id").inTable("runs");
      t.text("task_key");
      t.text("role");
      t.integer("wave");
      t.text("status");
      t.integer("passing");
      t.text("depends_on"); // JSON-encoded array
      t.text("verify");
      t.timestamp("updated_at");
      t.unique(["run_id", "task_key"]);
    });
  }

  if (!(await knex.schema.hasTable("events"))) {
    await knex.schema.createTable("events", (t) => {
      t.increments("id").primary();
      t.text("run_id").references("id").inTable("runs");
      t.timestamp("ts");
      t.text("type");
      t.text("from_actor");
      t.text("to_actor");
      t.text("summary");
      t.text("task_key").nullable();
      t.integer("wave").nullable();
      t.text("status").nullable();
    });
  }

  // Not yet wired into any route -- schema exists now for the follow-up
  // OAuth work to build on top of, per the task spec.
  if (!(await knex.schema.hasTable("users"))) {
    await knex.schema.createTable("users", (t) => {
      t.increments("id").primary();
      t.text("provider");
      t.text("provider_user_id");
      t.text("username");
      t.text("display_name");
      t.text("avatar_url");
      t.timestamp("created_at");
      t.unique(["provider", "provider_user_id"]);
    });
  }

  if (!(await knex.schema.hasTable("web_sessions"))) {
    await knex.schema.createTable("web_sessions", (t) => {
      t.text("id").primary();
      t.integer("user_id").nullable().references("id").inTable("users");
      t.text("auth_method");
      t.timestamp("created_at");
      t.timestamp("expires_at");
    });
  }

  // ---------------------------------------------------------------------
  // Skills library + per-run overrides. This is a management/staging
  // layer only -- see console/README.md's "Skills" section. It does NOT
  // change how the harness itself (skills/liberta/SKILL.md,
  // agents/*.md) is executed by Claude Code; it's a separate DB-backed
  // copy the console UI reads/writes, seeded once from those files at
  // first boot (see seedSkillsFromDisk below).
  // ---------------------------------------------------------------------
  if (!(await knex.schema.hasTable("skills"))) {
    await knex.schema.createTable("skills", (t) => {
      t.increments("id").primary();
      t.text("name").notNullable().unique();
      t.text("kind").notNullable(); // 'controller' or 'agent'
      t.text("content").notNullable();
      t.text("source").notNullable().defaultTo("built-in"); // 'built-in' or 'imported'
      t.text("description").nullable();
      t.timestamp("created_at");
      t.timestamp("updated_at");
    });
  }

  if (!(await knex.schema.hasTable("run_skill_overrides"))) {
    await knex.schema.createTable("run_skill_overrides", (t) => {
      t.increments("id").primary();
      t.text("run_id").notNullable();
      t.text("skill_name").notNullable();
      t.text("content").notNullable();
      t.timestamp("updated_at");
      t.unique(["run_id", "skill_name"]);
    });
  }
}

// ---------------------------------------------------------------------
// One-time seed of the `skills` table from the on-disk harness files
// (skills/liberta/SKILL.md as the "liberta" controller, every agents/*.md as
// an agent). Only runs if `skills` is currently empty, so hand-edits made
// later via the console UI are never clobbered by a restart. This reads
// those files exactly once at seed time -- it never writes back to disk.
// ---------------------------------------------------------------------
function parseDescription(content) {
  const match = content.match(/^description:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

async function seedSkillsFromDisk() {
  const existing = await knex("skills").count({ c: "id" }).first();
  const count = existing ? Number(existing.c) : 0;
  if (count > 0) return { seeded: false, count: 0 };

  const repoRoot = path.join(__dirname, "..");
  const rows = [];

  const controllerPath = path.join(repoRoot, "skills", "liberta", "SKILL.md");
  if (fs.existsSync(controllerPath)) {
    const content = fs.readFileSync(controllerPath, "utf8");
    rows.push({
      name: "liberta",
      kind: "controller",
      content,
      source: "built-in",
      description: parseDescription(content),
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  const agentsDir = path.join(repoRoot, "agents");
  if (fs.existsSync(agentsDir)) {
    const files = fs
      .readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of files) {
      const content = fs.readFileSync(path.join(agentsDir, f), "utf8");
      rows.push({
        name: path.basename(f, ".md"),
        kind: "agent",
        content,
        source: "built-in",
        description: parseDescription(content),
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }

  if (rows.length > 0) {
    await knex("skills").insert(rows);
  }
  return { seeded: true, count: rows.length };
}

module.exports = { knex, ensureSchema, seedSkillsFromDisk, DB_CLIENT, initDb };
