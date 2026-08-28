"use strict";

// ---------------------------------------------------------------------
// Knex connection module. The DB here is a queryable *mirror* of the
// file-based Linda run store (~/.claude/linda-runs/) -- the harness
// itself (SKILL.md's controller, scripts/wave-exec.js, etc.) keeps
// writing files unchanged and remains the source of truth. sync.js is
// what keeps this DB in sync with those files; this module only owns
// the connection + schema.
// ---------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const Knex = require("knex");

const DB_CLIENT = (process.env.DB_CLIENT || "sqlite3").trim();

let knex;

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
  knex = Knex({
    client: "pg",
    connection: DATABASE_URL,
  });
} else if (DB_CLIENT === "sqlite3" || DB_CLIENT === "sqlite") {
  const dataDir = path.join(__dirname, "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbFile = path.join(dataDir, "linda.sqlite");
  knex = Knex({
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
      t.integer("active").defaultTo(0);
      t.timestamp("updated_at");
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
  // change how the harness itself (skills/linda/SKILL.md,
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
// (skills/linda/SKILL.md as the "linda" controller, every agents/*.md as
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

  const controllerPath = path.join(repoRoot, "skills", "linda", "SKILL.md");
  if (fs.existsSync(controllerPath)) {
    const content = fs.readFileSync(controllerPath, "utf8");
    rows.push({
      name: "linda",
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

module.exports = { knex, ensureSchema, seedSkillsFromDisk, DB_CLIENT };
