import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initDb } from "../src/database.js";
import { createApp } from "../src/server.js";
import {
  createDatabaseBackup,
  createFullBackup,
  restoreBackup,
  validateBackup
} from "../src/backups.js";
import { PaperRepository } from "../src/repository.js";

test("database and full backups validate, hash files, and restore the library", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-backups-"));
  const dbPath = path.join(dir, "library.sqlite");
  const filesDir = path.join(dir, "files");
  const backupsDir = path.join(dir, "backups");

  try {
    await mkdir(filesDir, { recursive: true });
    await writeFile(path.join(filesDir, "paper.pdf"), "%PDF-1.4\nbackup paper\n%%EOF");
    initDb(dbPath, { backupsDir });
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({ title: "Backup paper", classification: {}, confidence: {}, evidence: {} });
    repo.confirmDraft(draftId);

    const record = createDatabaseBackup({ dbPath, backupsDir, reason: "test" });
    assert.equal(record.backupType, "database");
    assert.ok(existsSync(record.databasePath));
    assert.ok(validateBackup(record.manifestPath).valid);

    const full = createFullBackup({ dbPath, filesDir, backupsDir });
    assert.equal(full.backupType, "full");
    assert.ok(existsSync(path.join(full.directoryPath, "files", "paper.pdf")));
    assert.ok(validateBackup(full.manifestPath).valid);

    repo.createDraft({ title: "Changed paper", classification: {}, confidence: {}, evidence: {} });
    restoreBackup({ dbPath, filesDir, backupDirectory: full.directoryPath, backupsDir });
    initDb(dbPath, { backupsDir });
    assert.equal(new PaperRepository(dbPath).searchPapers()[0].title, "Backup paper");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup validation rejects a manifest path traversal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-backups-invalid-"));
  try {
    const manifestPath = path.join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ files: [{ path: "../outside", size: 0, sha256: "" }] }));
    assert.equal(validateBackup(manifestPath).valid, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed full restore rolls back both database and files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-backups-rollback-"));
  const dbPath = path.join(dir, "library.sqlite");
  const filesDir = path.join(dir, "files");
  const backupsDir = path.join(dir, "backups");

  try {
    await mkdir(filesDir, { recursive: true });
    await writeFile(path.join(filesDir, "paper.pdf"), "original file");
    initDb(dbPath, { backupsDir });
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({ title: "Original paper", classification: {}, confidence: {}, evidence: {} });
    const paperId = repo.confirmDraft(draftId);
    const full = createFullBackup({ dbPath, filesDir, backupsDir });

    repo.updatePaper(paperId, { expectedVersion: 1, title: "Changed paper" });
    await writeFile(path.join(filesDir, "paper.pdf"), "changed file");
    assert.throws(
      () => restoreBackup({
        dbPath,
        filesDir,
        backupsDir,
        backupDirectory: full.directoryPath,
        initDb: () => { throw new Error("injected restore failure"); }
      }),
      /injected restore failure/
    );
    assert.equal(new PaperRepository(dbPath).searchPapers()[0].title, "Changed paper");
    assert.equal(await readFile(path.join(filesDir, "paper.pdf"), "utf8"), "changed file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup automatic backups retain only the newest 30 records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-backups-retention-"));
  const dbPath = path.join(dir, "library.sqlite");
  const filesDir = path.join(dir, "files");
  const backupsDir = path.join(dir, "backups");
  const now = Date.parse("2026-07-11T00:00:00.000Z");

  try {
    await mkdir(filesDir, { recursive: true });
    initDb(dbPath, { backupsDir });
    const repo = new PaperRepository(dbPath);
    for (let index = 0; index < 31; index += 1) {
      const directoryPath = path.join(backupsDir, `old-${index}`);
      await mkdir(directoryPath, { recursive: true });
      repo.createBackupRecord({
        backupType: "automatic",
        directoryPath,
        createdAt: new Date(now - (31 - index) * 24 * 60 * 60 * 1000).toISOString()
      });
    }

    createApp({
      dbPath,
      filesDir,
      backupsDir,
      staticDir: path.resolve("public"),
      now: () => now,
      automaticBackupsEnabled: true
    });

    const remaining = new PaperRepository(dbPath).listBackupRecords().filter((record) => record.backupType === "automatic");
    assert.equal(remaining.length, 30);
    assert.equal((await readdir(backupsDir)).filter((name) => name.startsWith("old-")).length, 29);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
