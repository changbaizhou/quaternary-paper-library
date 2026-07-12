import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import properLockfile from "proper-lockfile";

import { initDb, openDb } from "../src/database.js";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await wait(10);
  }
}

function runInitProcess(dbPath, backupsDir, testConfig = {}) {
  const databaseModuleUrl = new URL("../src/database.js", import.meta.url).href;
  const script = `
    import { writeFileSync } from "node:fs";
    import { initDb } from ${JSON.stringify(databaseModuleUrl)};
    const config = JSON.parse(process.env.QPL_TEST_CONFIG);
    const internalTestOptions = { lockOptions: config.lockOptions };
    if (config.acquiredMarkerPath) {
      internalTestOptions.afterLockAcquired = () => {
        writeFileSync(config.acquiredMarkerPath, "acquired");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.holdLockMs);
      };
    }
    initDb(process.env.QPL_TEST_DB_PATH, {
      backupsDir: process.env.QPL_TEST_BACKUPS_DIR,
      internalTestOptions
    });
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        QPL_TEST_DB_PATH: dbPath,
        QPL_TEST_BACKUPS_DIR: backupsDir,
        QPL_TEST_CONFIG: JSON.stringify(testConfig)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`initDb child exited with code ${code}: ${stderr}`));
    });
  });
}

test("initDb creates a missing nested database parent before locking", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-parent-"));
  const dbPath = path.join(dir, "missing", "nested", "library.sqlite");

  try {
    initDb(dbPath);
    const db = openDb(dbPath);
    const versions = db.prepare("SELECT version FROM schema_migrations").all();
    db.close();
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration v3 creates page text schema, indexes, and FTS triggers without changing legacy fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-page-schema-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const db = openDb(dbPath);
    try {
      const columns = db.prepare("PRAGMA table_info(paper_pages)").all();
      assert.deepEqual(columns.map((column) => column.name), [
        "id", "paper_id", "page_number", "text", "text_source", "language",
        "character_count", "created_at", "updated_at"
      ]);
      assert.equal(columns.find((column) => column.name === "paper_id").notnull, 1);
      assert.equal(columns.find((column) => column.name === "page_number").notnull, 1);
      const objects = db.prepare(`
        SELECT type, name FROM sqlite_master
        WHERE name IN (
          'paper_pages_fts', 'paper_pages_ai', 'paper_pages_au', 'paper_pages_ad',
          'idx_paper_pages_paper_page', 'idx_paper_pages_page_number'
        )
        ORDER BY type, name
      `).all().map(({ type, name }) => ({ type, name }));
      assert.deepEqual(objects, [
        { type: "index", name: "idx_paper_pages_page_number" },
        { type: "index", name: "idx_paper_pages_paper_page" },
        { type: "table", name: "paper_pages_fts" },
        { type: "trigger", name: "paper_pages_ad" },
        { type: "trigger", name: "paper_pages_ai" },
        { type: "trigger", name: "paper_pages_au" }
      ]);
      const papersBefore = db.prepare("PRAGMA table_info(papers)").all().map((column) => column.name);
      const draftsBefore = db.prepare("PRAGMA table_info(drafts)").all().map((column) => column.name);
      db.prepare("INSERT INTO papers (title) VALUES (?)").run("FTS paper");
      const paperId = Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
      db.prepare("INSERT INTO paper_pages (paper_id, page_number, text, text_source, language, character_count) VALUES (?, ?, ?, ?, ?, ?)")
        .run(paperId, 1, "alpha searchable", "pdf", "", 16);
      assert.equal(db.prepare("SELECT rowid FROM paper_pages_fts WHERE paper_pages_fts MATCH 'alpha'").all().length, 1);
      db.prepare("UPDATE paper_pages SET text = ?, character_count = ? WHERE paper_id = ? AND page_number = ?")
        .run("beta searchable", 15, paperId, 1);
      assert.equal(db.prepare("SELECT rowid FROM paper_pages_fts WHERE paper_pages_fts MATCH 'alpha'").all().length, 0);
      assert.equal(db.prepare("SELECT rowid FROM paper_pages_fts WHERE paper_pages_fts MATCH 'beta'").all().length, 1);
      db.prepare("DELETE FROM paper_pages WHERE paper_id = ? AND page_number = ?").run(paperId, 1);
      assert.equal(db.prepare("SELECT rowid FROM paper_pages_fts WHERE paper_pages_fts MATCH 'beta'").all().length, 0);
      assert.deepEqual(db.prepare("PRAGMA table_info(papers)").all().map((column) => column.name), papersBefore);
      assert.deepEqual(db.prepare("PRAGMA table_info(drafts)").all().map((column) => column.name), draftsBefore);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration v3 rolls back all page schema changes when version recording fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-page-schema-rollback-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE papers (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '');
      CREATE TABLE drafts (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO schema_migrations (version) VALUES (1), (2);
      CREATE TRIGGER reject_v3
      BEFORE INSERT ON schema_migrations
      WHEN NEW.version = 3
      BEGIN
        SELECT RAISE(ABORT, 'injected v3 failure');
      END;
    `);
    legacy.close();

    assert.throws(() => initDb(dbPath), /injected v3 failure/);
    const failed = openDb(dbPath);
    try {
      assert.deepEqual(
        failed.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => ({ version })),
        [{ version: 1 }, { version: 2 }]
      );
      assert.equal(failed.prepare("SELECT 1 FROM sqlite_master WHERE name = 'paper_pages'").get(), undefined);
    } finally {
      failed.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock heartbeat remains live during long synchronous initialization", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-heartbeat-"));
  const dbPath = path.join(dir, "library.sqlite");
  const backupsDir = path.join(dir, "migration-backups");
  const acquiredMarkerPath = path.join(dir, "owner-acquired");
  const lockOptions = {
    stale: 2_000,
    update: 1_000,
    retries: { retries: 50, factor: 1.2, minTimeout: 50, maxTimeout: 250 }
  };

  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE drafts (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
      CREATE TABLE papers (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
    `);
    legacy.close();

    const owner = runInitProcess(dbPath, backupsDir, {
      lockOptions,
      acquiredMarkerPath,
      holdLockMs: 3_500
    });
    await waitFor(() => existsSync(acquiredMarkerPath));

    let contenderCompleted = false;
    const contender = runInitProcess(dbPath, backupsDir, { lockOptions }).then(() => {
      contenderCompleted = true;
    });
    await wait(2_600);
    assert.equal(contenderCompleted, false);

    await Promise.all([owner, contender]);
    const snapshots = (await readdir(backupsDir)).filter((name) => /^pre-migration-.*\.sqlite$/.test(name));
    assert.equal(snapshots.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initDb waits for an existing proper-lockfile lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-"));
  const dbPath = path.join(dir, "library.sqlite");
  const backupsDir = path.join(dir, "migration-backups");
  let release;

  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE drafts (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
      CREATE TABLE papers (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
    `);
    legacy.close();

    release = properLockfile.lockSync(dbPath, { realpath: false, stale: 10_000, update: 2_000 });
    let completed = false;
    const initialization = runInitProcess(dbPath, backupsDir).then(() => {
      completed = true;
    });

    await wait(200);
    assert.equal(completed, false);
    release();
    release = null;
    await initialization;

    const migrated = openDb(dbPath);
    const versions = migrated.prepare("SELECT version FROM schema_migrations").all();
    migrated.close();
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock worker cleans up after acquisition failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-failure-"));
  const dbPath = path.join(dir, "library.sqlite");
  let release;

  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE drafts (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
      CREATE TABLE papers (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
    `);
    legacy.close();

    release = properLockfile.lockSync(dbPath, { realpath: false });
    assert.throws(
      () => initDb(dbPath, {
        internalTestOptions: {
          lockOptions: { retries: 0 },
          acquireTimeoutMs: 2_000
        }
      }),
      /already being held/
    );
    release();
    release = null;

    initDb(dbPath);
    const migrated = openDb(dbPath);
    const versions = migrated.prepare("SELECT version FROM schema_migrations").all();
    migrated.close();
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock worker times out acquisition and leaves no owned lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-timeout-"));
  const dbPath = path.join(dir, "library.sqlite");
  let release;

  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE drafts (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
      CREATE TABLE papers (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
    `);
    legacy.close();

    release = properLockfile.lockSync(dbPath, { realpath: false });
    assert.throws(
      () => initDb(dbPath, {
        internalTestOptions: { acquireTimeoutMs: 100 }
      }),
      /Timed out waiting for database initialization lock/
    );
    release();
    release = null;

    initDb(dbPath);
    const migrated = openDb(dbPath);
    const versions = migrated.prepare("SELECT version FROM schema_migrations").all();
    migrated.close();
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("compromised worker lock fails safely and permits retry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-compromised-"));
  const dbPath = path.join(dir, "library.sqlite");
  const acquiredMarkerPath = path.join(dir, "owner-acquired");

  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE drafts (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
      CREATE TABLE papers (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
    `);
    legacy.close();

    const ownerResult = runInitProcess(dbPath, path.join(dir, "backups"), {
      lockOptions: {
        stale: 2_000,
        update: 1_000,
        retries: { retries: 0 }
      },
      acquiredMarkerPath,
      holdLockMs: 1_500
    }).then(
      () => null,
      (error) => error
    );
    await waitFor(() => existsSync(acquiredMarkerPath));
    await rm(`${dbPath}.lock`, { recursive: true, force: true });

    const compromiseError = await ownerResult;
    assert.ok(compromiseError instanceof Error);
    assert.match(compromiseError.message, /ECOMPROMISED/);

    initDb(dbPath);
    const migrated = openDb(dbPath);
    const versions = migrated.prepare("SELECT version FROM schema_migrations").all();
    migrated.close();
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initDb reclaims a stale proper-lockfile lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE drafts (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
      CREATE TABLE papers (id INTEGER PRIMARY KEY, stored_filename TEXT DEFAULT '', stored_path TEXT DEFAULT '');
    `);
    legacy.close();

    const lockPath = `${dbPath}.lock`;
    mkdirSync(lockPath);
    const staleTime = new Date(Date.now() - 20_000);
    utimesSync(lockPath, staleTime, staleTime);

    initDb(dbPath);

    const migrated = openDb(dbPath);
    const versions = migrated.prepare("SELECT version FROM schema_migrations").all();
    migrated.close();
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initDb runs versioned migrations without losing existing papers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-db-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const before = openDb(dbPath);
    before.prepare("INSERT INTO papers (doi, title, search_text) VALUES (?, ?, ?)").run(
      "https://doi.org/10.1000/LEGACY.",
      "The Legacy–Paper Record",
      "legacy paper"
    );
    before.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    before.close();

    initDb(dbPath);
    const after = openDb(dbPath);
    let migrations;
    let columns;
    let paper;
    let tables;
    try {
      migrations = after.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      columns = after.prepare("PRAGMA table_info(papers)").all().map((item) => item.name);
      paper = after.prepare(
        "SELECT title, version, deleted_at, normalized_doi, normalized_title FROM papers WHERE doi = ?"
      ).get("https://doi.org/10.1000/LEGACY.");
      tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((item) => item.name);
    } finally {
      after.close();
    }

    assert.deepEqual(migrations.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(columns.includes("normalized_doi"));
    assert.ok(columns.includes("normalized_title"));
    assert.ok(columns.includes("file_sha256"));
    assert.ok(columns.includes("version"));
    assert.ok(columns.includes("deleted_at"));
    assert.ok(columns.includes("merged_into_id"));
    assert.equal(paper.title, "The Legacy–Paper Record");
    assert.equal(paper.normalized_doi, "10.1000/legacy");
    assert.equal(paper.normalized_title, "legacy paper record");
    assert.equal(paper.version, 1);
    assert.equal(paper.deleted_at, null);
    assert.ok(tables.includes("paper_files"));
    assert.ok(tables.includes("backup_records"));
    assert.ok(tables.includes("paper_merge_log"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initDb snapshots and fully migrates pre-v1 file records exactly once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-db-"));
  const dbPath = path.join(dir, "library.sqlite");
  const backupsDir = path.join(dir, "migration-backups");

  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stored_filename TEXT NOT NULL DEFAULT '',
        stored_path TEXT NOT NULL DEFAULT '',
        file_sha256 TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stored_filename TEXT NOT NULL DEFAULT '',
        stored_path TEXT NOT NULL DEFAULT '',
        file_sha256 TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT ''
      );
    `);
    legacy.prepare(`
      INSERT INTO papers (stored_filename, stored_path, file_sha256, title, search_text)
      VALUES (?, ?, ?, ?, ?)
    `).run("paper.pdf", "library/paper.pdf", "paper-hash", "Legacy paper", "legacy paper");
    legacy.prepare(`
      INSERT INTO drafts (stored_filename, stored_path, file_sha256)
      VALUES (?, ?, ?)
    `).run("draft.pdf", "inbox/draft.pdf", "draft-hash");
    legacy.close();

    initDb(dbPath, { backupsDir });

    const snapshots = (await readdir(backupsDir)).filter((name) => /^pre-migration-.*\.sqlite$/.test(name));
    assert.equal(snapshots.length, 1);

    const snapshot = openDb(path.join(backupsDir, snapshots[0]));
    const snapshotTables = snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((item) => item.name);
    const snapshotColumns = snapshot.prepare("PRAGMA table_info(papers)").all().map((item) => item.name);
    const snapshotPaper = snapshot.prepare("SELECT title FROM papers").get();
    snapshot.close();

    assert.ok(!snapshotTables.includes("schema_migrations"));
    assert.ok(!snapshotColumns.includes("normalized_doi"));
    assert.equal(snapshotPaper.title, "Legacy paper");

    initDb(dbPath, { backupsDir });

    const snapshotsAfterRetry = (await readdir(backupsDir)).filter((name) => /^pre-migration-.*\.sqlite$/.test(name));
    const migrated = openDb(dbPath);
    const versions = migrated.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    const paperColumns = migrated.prepare("PRAGMA table_info(papers)").all().map((item) => item.name);
    const draftColumns = migrated.prepare("PRAGMA table_info(drafts)").all().map((item) => item.name);
    const indexes = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((item) => item.name);
    const migratedTables = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((item) => item.name);
    const busyTimeout = migrated.prepare("PRAGMA busy_timeout").get().timeout;
    const files = migrated.prepare(`
      SELECT paper_id, draft_id, stored_filename, stored_path, sha256
      FROM paper_files
      ORDER BY id
    `).all().map((item) => ({ ...item }));
    const migratedPaper = migrated.prepare("SELECT title, version FROM papers").get();
    migrated.close();

    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
    for (const column of ["normalized_doi", "normalized_title", "file_sha256", "version", "deleted_at", "merged_into_id"]) {
      assert.ok(paperColumns.includes(column), `missing papers.${column}`);
    }
    for (const column of ["file_sha256", "duplicate_candidates_json"]) {
      assert.ok(draftColumns.includes(column), `missing drafts.${column}`);
    }
    for (const index of [
      "idx_paper_files_sha256",
      "idx_paper_files_paper",
      "idx_papers_deleted_at",
      "idx_papers_normalized_doi",
      "idx_papers_normalized_title"
    ]) {
      assert.ok(indexes.includes(index), `missing index ${index}`);
    }
    for (const table of ["paper_files", "backup_records", "paper_merge_log"]) {
      assert.ok(migratedTables.includes(table), `missing table ${table}`);
    }
    assert.deepEqual(files, [
      {
        paper_id: 1,
        draft_id: null,
        stored_filename: "paper.pdf",
        stored_path: "library/paper.pdf",
        sha256: "paper-hash"
      },
      {
        paper_id: null,
        draft_id: 1,
        stored_filename: "draft.pdf",
        stored_path: "inbox/draft.pdf",
        sha256: "draft-hash"
      }
    ]);
    assert.equal(snapshotsAfterRetry.length, 1);
    assert.equal(busyTimeout, 5000);
    assert.equal(migratedPaper.title, "Legacy paper");
    assert.equal(migratedPaper.version, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initDb rolls back migration failure, releases its lock, and retries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-db-"));
  const dbPath = path.join(dir, "library.sqlite");
  const backupsDir = path.join(dir, "migration-backups");

  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stored_filename TEXT NOT NULL DEFAULT '',
        stored_path TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stored_filename TEXT NOT NULL DEFAULT '',
        stored_path TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TRIGGER reject_migration_version
      BEFORE INSERT ON schema_migrations
      BEGIN
        SELECT RAISE(ABORT, 'injected migration failure');
      END;
    `);
    const paperColumnsBefore = legacy.prepare("PRAGMA table_info(papers)").all().map((item) => item.name);
    const draftColumnsBefore = legacy.prepare("PRAGMA table_info(drafts)").all().map((item) => item.name);
    legacy.close();

    assert.throws(
      () => initDb(dbPath, { backupsDir }),
      /injected migration failure/
    );

    const failed = openDb(dbPath);
    const paperColumnsAfter = failed.prepare("PRAGMA table_info(papers)").all().map((item) => item.name);
    const draftColumnsAfter = failed.prepare("PRAGMA table_info(drafts)").all().map((item) => item.name);
    const versionsAfter = failed.prepare("SELECT version FROM schema_migrations").all();
    const migrationTablesAfter = failed.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('paper_files', 'backup_records', 'paper_merge_log')
    `).all();
    const migrationIndexesAfter = failed.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'idx_%'
    `).all();
    failed.close();

    assert.deepEqual(paperColumnsAfter, paperColumnsBefore);
    assert.deepEqual(draftColumnsAfter, draftColumnsBefore);
    assert.deepEqual(versionsAfter, []);
    assert.deepEqual(migrationTablesAfter, []);
    assert.deepEqual(migrationIndexesAfter, []);

    const repair = openDb(dbPath);
    repair.exec("DROP TRIGGER reject_migration_version");
    repair.close();

    initDb(dbPath, { backupsDir });
    const retried = openDb(dbPath);
    const retriedVersions = retried.prepare("SELECT version FROM schema_migrations").all();
    const retriedColumns = retried.prepare("PRAGMA table_info(papers)").all().map((item) => item.name);
    retried.close();

    assert.deepEqual(retriedVersions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(retriedColumns.includes("normalized_doi"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initDb serializes concurrent initialization across processes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-db-"));
  const dbPath = path.join(dir, "library.sqlite");
  const backupsDir = path.join(dir, "migration-backups");

  try {
    const legacy = openDb(dbPath);
    legacy.exec(`
      CREATE TABLE drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stored_filename TEXT NOT NULL DEFAULT '',
        stored_path TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stored_filename TEXT NOT NULL DEFAULT '',
        stored_path TEXT NOT NULL DEFAULT ''
      );
    `);
    legacy.close();

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => runInitProcess(dbPath, backupsDir))
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled", "fulfilled", "fulfilled"],
      results.filter((result) => result.status === "rejected").map((result) => result.reason)
    );

    const snapshots = (await readdir(backupsDir)).filter((name) => /^pre-migration-.*\.sqlite$/.test(name));
    const db = openDb(dbPath);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    db.close();

    assert.equal(snapshots.length, 1);
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initDb remains serialized across repeated concurrent initialization rounds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-db-stress-"));

  try {
    for (let round = 0; round < 5; round += 1) {
      const dbPath = path.join(dir, `library-${round}.sqlite`);
      const backupsDir = path.join(dir, `backups-${round}`);
      const legacy = openDb(dbPath);
      legacy.exec(`
        CREATE TABLE drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stored_filename TEXT NOT NULL DEFAULT '',
          stored_path TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE papers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stored_filename TEXT NOT NULL DEFAULT '',
          stored_path TEXT NOT NULL DEFAULT ''
        );
      `);
      legacy.close();

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => runInitProcess(dbPath, backupsDir))
      );
      assert.deepEqual(
        results.map((result) => result.status),
        Array(6).fill("fulfilled"),
        results.filter((result) => result.status === "rejected").map((result) => result.reason)
      );

      const snapshots = (await readdir(backupsDir)).filter((name) => /^pre-migration-.*\.sqlite$/.test(name));
      const migrated = openDb(dbPath);
      const versions = migrated.prepare("SELECT version FROM schema_migrations").all();
      migrated.close();

      assert.equal(snapshots.length, 1);
      assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
