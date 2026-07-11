import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initDb, openDb } from "../src/database.js";

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

test("initDb snapshots a legacy database before applying pending migrations", async () => {
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
        stored_path TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT ''
      );
    `);
    legacy.prepare("INSERT INTO papers (title, search_text) VALUES (?, ?)").run("Legacy paper", "legacy paper");
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

    const migrated = openDb(dbPath);
    const versions = migrated.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    const migratedPaper = migrated.prepare("SELECT title, version FROM papers").get();
    migrated.close();

    assert.deepEqual(versions.map((item) => item.version), [1]);
    assert.equal(migratedPaper.title, "Legacy paper");
    assert.equal(migratedPaper.version, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
