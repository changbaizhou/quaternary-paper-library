import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as database from "../src/database.js";

const { initDb, openDb } = database;

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

function lockPathFor(dbPath) {
  return `${path.resolve(dbPath)}.init-lock`;
}

function writeExpiredLock(dbPath, { nonce, pid }) {
  const lockPath = lockPathFor(dbPath);
  mkdirSync(lockPath);
  writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
    nonce,
    pid,
    leaseDurationMs: 100,
    heartbeatIntervalMs: 25,
    publishedAt: Date.now() - 1_000
  }));
  const heartbeatPath = path.join(lockPath, "heartbeat");
  writeFileSync(heartbeatPath, "");
  const expired = new Date(Date.now() - 1_000);
  utimesSync(heartbeatPath, expired, expired);
}

function runInitProcess(dbPath, backupsDir) {
  const databaseModuleUrl = new URL("../src/database.js", import.meta.url).href;
  const script = `
    import { initDb } from ${JSON.stringify(databaseModuleUrl)};
    initDb(process.env.QPL_TEST_DB_PATH, { backupsDir: process.env.QPL_TEST_BACKUPS_DIR });
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        QPL_TEST_DB_PATH: dbPath,
        QPL_TEST_BACKUPS_DIR: backupsDir
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

function runLockRaceProcess({ dbPath, readyDir, resultDir, goPath, releasePath, id }) {
  const databaseModuleUrl = new URL("../src/database.js", import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { acquireInitializationLock } from ${JSON.stringify(databaseModuleUrl)};
    const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    try {
      const release = acquireInitializationLock(process.env.QPL_TEST_DB_PATH, {
        timeoutMs: 400,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 50,
        beforePublish() {
          writeFileSync(path.join(process.env.QPL_TEST_READY_DIR, process.env.QPL_TEST_ID), "ready");
          while (!existsSync(process.env.QPL_TEST_GO_PATH)) sleep();
        }
      });
      writeFileSync(path.join(process.env.QPL_TEST_RESULT_DIR, process.env.QPL_TEST_ID), "acquired");
      while (!existsSync(process.env.QPL_TEST_RELEASE_PATH)) sleep();
      release();
    } catch (error) {
      const result = error.message.includes("Timed out") ? "timed-out" : "error: " + error.stack;
      writeFileSync(path.join(process.env.QPL_TEST_RESULT_DIR, process.env.QPL_TEST_ID), result);
      if (!error.message.includes("Timed out")) process.exitCode = 1;
    }
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        QPL_TEST_DB_PATH: dbPath,
        QPL_TEST_READY_DIR: readyDir,
        QPL_TEST_RESULT_DIR: resultDir,
        QPL_TEST_GO_PATH: goPath,
        QPL_TEST_RELEASE_PATH: releasePath,
        QPL_TEST_ID: id
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lock race child exited with code ${code}: ${stderr}`));
    });
  });
}

test("initialization lock publishes owner metadata atomically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-"));
  const dbPath = path.join(dir, "library.sqlite");
  let release;

  try {
    assert.equal(typeof database.acquireInitializationLock, "function");
    let publicationInspected = false;
    release = database.acquireInitializationLock(dbPath, {
      beforePublish({ lockPath, temporaryLockPath, nonce }) {
        publicationInspected = true;
        assert.equal(existsSync(lockPath), false);
        const owner = JSON.parse(readFileSync(path.join(temporaryLockPath, "owner.json"), "utf8"));
        assert.equal(owner.nonce, nonce);
        assert.ok(existsSync(path.join(temporaryLockPath, "heartbeat")));
      }
    });

    assert.equal(publicationInspected, true);
    assert.ok(existsSync(path.join(lockPathFor(dbPath), "owner.json")));
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("initialization lock release preserves a lock with a different nonce", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    const release = database.acquireInitializationLock(dbPath);
    const ownerPath = path.join(lockPathFor(dbPath), "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, nonce: "replacement-owner" }));

    assert.equal(release(), false);
    assert.ok(existsSync(lockPathFor(dbPath)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("competing atomic lock publications produce one owner and clean losing candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-"));
  const dbPath = path.join(dir, "library.sqlite");
  const readyDir = path.join(dir, "ready");
  const resultDir = path.join(dir, "results");
  const goPath = path.join(dir, "go");
  const releasePath = path.join(dir, "release");

  try {
    assert.equal(typeof database.acquireInitializationLock, "function");
    mkdirSync(readyDir);
    mkdirSync(resultDir);
    const children = ["one", "two"].map((id) => runLockRaceProcess({
      dbPath,
      readyDir,
      resultDir,
      goPath,
      releasePath,
      id
    }));

    await waitFor(() => readdirSync(readyDir).length === 2);
    writeFileSync(goPath, "go");
    await waitFor(() => readdirSync(resultDir).length === 2);

    const results = readdirSync(resultDir).map((name) => readFileSync(path.join(resultDir, name), "utf8")).sort();
    assert.deepEqual(results, ["acquired", "timed-out"]);
    assert.ok(existsSync(path.join(lockPathFor(dbPath), "owner.json")));
    assert.equal(
      readdirSync(dir).filter((name) => name.includes(".init-lock.tmp-")).length,
      0
    );

    writeFileSync(releasePath, "release");
    const settled = await Promise.allSettled(children);
    assert.deepEqual(
      settled.map((result) => result.status),
      ["fulfilled", "fulfilled"],
      settled.filter((result) => result.status === "rejected").map((result) => result.reason)
    );
  } finally {
    writeFileSync(releasePath, "release");
    await rm(dir, { recursive: true, force: true });
  }
});

test("initialization lock reclaims an expired dead-owner lease", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-"));
  const dbPath = path.join(dir, "library.sqlite");
  let release;

  try {
    assert.equal(typeof database.acquireInitializationLock, "function");
    writeExpiredLock(dbPath, { nonce: "expired-dead", pid: 2_147_483_647 });
    release = database.acquireInitializationLock(dbPath, { timeoutMs: 500 });
    const owner = JSON.parse(readFileSync(path.join(lockPathFor(dbPath), "owner.json"), "utf8"));
    assert.notEqual(owner.nonce, "expired-dead");
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("initialization lock reclaims an expired lease despite PID reuse", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-"));
  const dbPath = path.join(dir, "library.sqlite");
  let release;

  try {
    assert.equal(typeof database.acquireInitializationLock, "function");
    writeExpiredLock(dbPath, { nonce: "expired-reused-pid", pid: process.pid });
    release = database.acquireInitializationLock(dbPath, { timeoutMs: 500 });
    const owner = JSON.parse(readFileSync(path.join(lockPathFor(dbPath), "owner.json"), "utf8"));
    assert.notEqual(owner.nonce, "expired-reused-pid");
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("initialization lock does not reclaim a live heartbeat lease", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-lock-"));
  const dbPath = path.join(dir, "library.sqlite");
  let release;

  try {
    assert.equal(typeof database.acquireInitializationLock, "function");
    release = database.acquireInitializationLock(dbPath, {
      leaseDurationMs: 120,
      heartbeatIntervalMs: 20
    });
    await wait(300);

    assert.throws(
      () => database.acquireInitializationLock(dbPath, { timeoutMs: 100 }),
      /Timed out waiting for database initialization lock/
    );
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("initDb runs versioned migrations without losing existing papers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-db-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const before = openDb(dbPath);
    before.prepare("INSERT INTO papers (title, search_text) VALUES (?, ?)").run("Legacy paper", "legacy paper");
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
      paper = after.prepare("SELECT title, version, deleted_at FROM papers WHERE title = ?").get("Legacy paper");
      tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((item) => item.name);
    } finally {
      after.close();
    }

    assert.deepEqual(migrations.map((item) => item.version), [1]);
    assert.ok(columns.includes("normalized_doi"));
    assert.ok(columns.includes("normalized_title"));
    assert.ok(columns.includes("file_sha256"));
    assert.ok(columns.includes("version"));
    assert.ok(columns.includes("deleted_at"));
    assert.ok(columns.includes("merged_into_id"));
    assert.equal(paper.title, "Legacy paper");
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

    assert.deepEqual(versions.map((item) => item.version), [1]);
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

test("initDb rolls back all schema changes when migration version insertion fails", async () => {
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

    assert.deepEqual(retriedVersions.map((item) => item.version), [1]);
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
    assert.deepEqual(versions.map((item) => item.version), [1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
