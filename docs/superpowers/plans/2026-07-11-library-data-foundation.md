# Library Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make confirmed papers safely editable and add versioned migrations, autosaved notes, recycle-bin deletion, duplicate detection and merging, plus local backup and restore.

**Architecture:** Keep the current Express and SQLite application, but add focused migration, duplicate, file-storage, and backup modules. Repository methods remain the transaction boundary, API routes expose explicit mutations, and the existing frontend gains save-state and maintenance views without rewriting the PDF reader.

**Tech Stack:** Node.js 24, `node:sqlite`, Express 5, Multer, native browser modules, `node:test`, SQLite transactions, SHA-256 from `node:crypto`.

---

## File Map

- Create `src/migrations.js`: ordered, idempotent SQLite schema migrations.
- Create `src/paperData.js`: normalization, editable field lists, note field lists, and safe merge helpers.
- Create `src/duplicates.js`: SHA-256, DOI/title normalization, title similarity, and duplicate ranking.
- Create `src/fileStorage.js`: resolve, retain, move, and remove PDF files inside the configured library root.
- Create `src/backups.js`: database and full-folder backup creation, validation, listing, and restoration.
- Modify `src/config.js`: derive the backup root from the active database location.
- Modify `src/database.js`: initialize the baseline schema and run migrations.
- Modify `src/repository.js`: edit, trash, restore, purge, duplicate, merge, and backup-record operations.
- Modify `src/server.js`: mutation, trash, duplicate, merge, backup, and restore endpoints.
- Modify `public/index.html`: save state, duplicate review, trash, and maintenance controls.
- Modify `public/app.js`: explicit metadata save, note autosave, trash, duplicate, merge, backup, and restore flows.
- Modify `public/styles.css`: compact operational UI for the new states and maintenance views.
- Create `tests/database.test.js`: migration and legacy-data preservation tests.
- Create `tests/duplicates.test.js`: normalization, hashing, and similarity tests.
- Create `tests/backups.test.js`: backup manifest, validation, and restore tests.
- Modify `tests/repository.test.js`: edit, conflict, trash, restore, purge, and merge tests.
- Modify `tests/api.test.js`: new API integration tests.
- Modify `tests/uiStructure.test.js`: frontend control and request wiring tests.
- Create `playwright.config.js`: isolated Chromium smoke-test configuration.
- Create `tests/browser/dataFoundation.spec.js`: real-browser phase-one workflow and viewport checks.
- Modify `README.md`: editing, recycle-bin, duplicate, backup, and restore instructions.

## Task 1: Versioned Database Migrations

**Files:**
- Create: `src/migrations.js`
- Modify: `src/database.js`
- Create: `tests/database.test.js`

- [ ] **Step 1: Write failing migration tests**

Add tests that initialize a database, insert a legacy paper, run initialization again, and assert the new schema and preserved row:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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
    const migrations = after.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    const columns = after.prepare("PRAGMA table_info(papers)").all().map((item) => item.name);
    const paper = after.prepare("SELECT title, version, deleted_at FROM papers WHERE title = ?").get("Legacy paper");
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((item) => item.name);
    after.close();

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
```

Add a second test that creates a minimal legacy `drafts` and `papers` schema without `schema_migrations`, inserts one paper, calls `initDb(dbPath, { backupsDir })`, and asserts exactly one `pre-migration-*.sqlite` snapshot exists before the migrated database is changed.

- [ ] **Step 2: Run the test and verify the missing migration table failure**

Run: `node --test tests/database.test.js`

Expected: FAIL because `schema_migrations` and the new columns do not exist.

- [ ] **Step 3: Implement ordered migrations**

Export `runMigrations(db)` from `src/migrations.js`. Migration 1 must create `schema_migrations`, add these columns with `PRAGMA table_info` checks, and create supporting tables and indexes:

```js
const migrations = [
  {
    version: 1,
    up(db) {
      ensureColumn(db, "drafts", "file_sha256", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "drafts", "duplicate_candidates_json", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn(db, "papers", "normalized_doi", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "normalized_title", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "file_sha256", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "version", "INTEGER NOT NULL DEFAULT 1");
      ensureColumn(db, "papers", "deleted_at", "TEXT");
      ensureColumn(db, "papers", "merged_into_id", "INTEGER");
      db.exec(`
        CREATE TABLE IF NOT EXISTS paper_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          paper_id INTEGER,
          draft_id INTEGER,
          stored_filename TEXT NOT NULL DEFAULT '',
          stored_path TEXT NOT NULL DEFAULT '',
          sha256 TEXT NOT NULL DEFAULT '',
          size_bytes INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_paper_files_sha256 ON paper_files(sha256);
        CREATE INDEX IF NOT EXISTS idx_paper_files_paper ON paper_files(paper_id);
        CREATE TABLE IF NOT EXISTS backup_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          backup_type TEXT NOT NULL,
          stored_path TEXT NOT NULL,
          manifest_sha256 TEXT NOT NULL DEFAULT '',
          size_bytes INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS paper_merge_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_paper_id INTEGER NOT NULL,
          source_paper_id INTEGER NOT NULL,
          backup_record_id INTEGER,
          summary_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_papers_deleted_at ON papers(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_papers_normalized_doi ON papers(normalized_doi);
        CREATE INDEX IF NOT EXISTS idx_papers_normalized_title ON papers(normalized_title);
      `);
      db.exec(`
        INSERT INTO paper_files (paper_id, stored_filename, stored_path, sha256)
        SELECT id, stored_filename, stored_path, file_sha256
        FROM papers
        WHERE stored_path <> ''
          AND NOT EXISTS (SELECT 1 FROM paper_files WHERE paper_files.paper_id = papers.id);
        INSERT INTO paper_files (draft_id, stored_filename, stored_path, sha256)
        SELECT id, stored_filename, stored_path, file_sha256
        FROM drafts
        WHERE stored_path <> ''
          AND NOT EXISTS (SELECT 1 FROM paper_files WHERE paper_files.draft_id = drafts.id);
      `);
    }
  }
];
```

`runMigrations` must create `schema_migrations`, execute each missing migration inside `BEGIN IMMEDIATE`/`COMMIT`, insert the version only after success, and `ROLLBACK` on error. `initDb(dbPath, { backupsDir = path.join(path.dirname(dbPath), "backups") } = {})` must detect an existing database with pending migrations, create a timestamped SQLite snapshot inside `backupsDir`, and only then run migrations. New empty databases do not need a pre-migration snapshot.

- [ ] **Step 4: Run migration and full tests**

Run: `node --test tests/database.test.js tests/repository.test.js`

Expected: PASS with no lost legacy paper and no repository regression.

- [ ] **Step 5: Commit migration support**

```powershell
git add src/migrations.js src/database.js tests/database.test.js
git -c user.name=changbaizhou -c user.email=188980047+changbaizhou@users.noreply.github.com commit --author="changbaizhou <188980047+changbaizhou@users.noreply.github.com>" -m "feat: add versioned database migrations"
```

## Task 2: Confirmed Paper Editing and Conflict Protection

**Files:**
- Create: `src/paperData.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `tests/repository.test.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Write failing repository tests for edit and stale versions**

Create a confirmed paper, update title and notes with version 1, and assert version 2 and searchable text. Then repeat with expected version 1 and assert `VersionConflictError`:

```js
const updated = repo.updatePaper(paperId, {
  expectedVersion: 1,
  title: "Revised Holocene record",
  notesCoreFindings: "The revised note is searchable."
});
assert.equal(updated.version, 2);
assert.equal(updated.title, "Revised Holocene record");
assert.equal(repo.searchPapers({ query: "revised note" })[0].id, paperId);
assert.throws(
  () => repo.updatePaper(paperId, { expectedVersion: 1, title: "Stale edit" }),
  (error) => error.name === "VersionConflictError"
);
```

- [ ] **Step 2: Run repository tests and verify failure**

Run: `node --test tests/repository.test.js`

Expected: FAIL because `updatePaper` and `VersionConflictError` do not exist.

- [ ] **Step 3: Add paper normalization and update transaction**

In `src/paperData.js`, export exact editable field lists and normalization helpers:

```js
export const metadataFields = [
  "doi", "title", "authors", "journal", "year", "abstract", "keywords",
  "themes", "regions", "periods", "materials", "methods", "proxies"
];

export const noteFields = [
  "readingStatus", "notesResearchQuestion", "notesRegion", "notesMaterialsMethods",
  "notesChronology", "notesCoreFindings", "notesLimits", "notesQuotePoints", "notesPersonal"
];

export function normalizeDoi(value) {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/[\s.,;:]+$/, "");
}

export function normalizeTitle(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
```

In `src/repository.js`, map `version`, `deletedAt`, `mergedIntoId`, normalized fields, file hash, and draft duplicate candidates. Add `VersionConflictError`. `updatePaper` must load the current paper, reject missing papers, compare `expectedVersion`, merge only whitelisted fields, require a non-empty title, rebuild `search_text`, and update with `WHERE id = ? AND version = ?` in one transaction.

- [ ] **Step 4: Write failing API tests for metadata and note endpoints**

Add API tests for:

```js
const editResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ expectedVersion: 1, title: "Edited title" })
});
assert.equal(editResponse.status, 200);
assert.equal((await editResponse.json()).version, 2);

const staleResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ expectedVersion: 1, title: "Stale title" })
});
assert.equal(staleResponse.status, 409);

const notesResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/notes`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ expectedVersion: 2, notesPersonal: "Autosaved note" })
});
assert.equal(notesResponse.status, 200);
assert.equal((await notesResponse.json()).notesPersonal, "Autosaved note");
```

- [ ] **Step 5: Implement explicit API routes**

Add `PATCH /api/papers/:id` using only `metadataFields`, and `PATCH /api/papers/:id/notes` using only `noteFields`. Return `404` for missing papers, `409` for `VersionConflictError`, and `400` for invalid titles, years, arrays, or expected versions. Do not accept `storedPath`, `fileSha256`, `deletedAt`, `version`, or merge fields from request bodies.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/repository.test.js tests/api.test.js`

Expected: PASS for edit, conflict, note, reader, upload, and translation tests.

- [ ] **Step 7: Commit paper editing**

```powershell
git add src/paperData.js src/repository.js src/server.js tests/repository.test.js tests/api.test.js
git -c user.name=changbaizhou -c user.email=188980047+changbaizhou@users.noreply.github.com commit --author="changbaizhou <188980047+changbaizhou@users.noreply.github.com>" -m "feat: save confirmed paper changes"
```

## Task 3: Metadata Save and Note Autosave UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/uiStructure.test.js`

- [ ] **Step 1: Write failing frontend structure tests**

Assert that the page exposes `savePaperButton` and `paperSaveStatus`, and that `app.js` calls both mutation endpoints, tracks `expectedVersion`, and debounces note saves:

```js
assert.match(html, /id="savePaperButton"/);
assert.match(html, /id="paperSaveStatus"/);
assert.match(script, /\/api\/papers\/\$\{state\.selectedPaper\.id\}/);
assert.match(script, /\/api\/papers\/\$\{state\.selectedPaper\.id\}\/notes/);
assert.match(script, /expectedVersion/);
assert.match(script, /NOTE_AUTOSAVE_DELAY_MS/);
```

- [ ] **Step 2: Run the UI structure test and verify failure**

Run: `node --test tests/uiStructure.test.js`

Expected: FAIL because save state and edit requests are absent.

- [ ] **Step 3: Add save controls and frontend state**

Replace the single confirmation button area with:

```html
<div class="detail-save-bar">
  <span id="paperSaveStatus" aria-live="polite">未修改</span>
  <button id="savePaperButton" type="submit">确认入库</button>
</div>
```

Add `NOTE_AUTOSAVE_DELAY_MS = 800`, `state.noteAutosaveTimer`, and `state.noteSaveRequestId`. `fillFormFromDraft` must set button text to `确认入库`; `fillFormFromPaper` must set it to `保存更改` and show `已保存`.

On paper form submit, send only metadata fields with `expectedVersion: state.selectedPaper.version`. Patch returned paper into state and refill the form. For the nine note controls, listen to `input`/`change`, show `有未保存笔记`, debounce 800 ms, and send only note fields plus the latest expected version. A stale `409` must reload papers and show `论文已在其他操作中更新，请检查后重试` rather than silently overwriting.

- [ ] **Step 4: Style stable save states**

Add a sticky `.detail-save-bar` at the bottom of the detail form, with fixed-height status text and distinct neutral, saving, success, and error classes. Ensure the button does not change width between `确认入库` and `保存更改`.

- [ ] **Step 5: Run frontend and full tests**

Run: `node --test tests/uiStructure.test.js tests/api.test.js`

Expected: PASS and existing draft confirmation remains wired.

- [ ] **Step 6: Commit frontend saving**

```powershell
git add public/index.html public/app.js public/styles.css tests/uiStructure.test.js
git -c user.name=changbaizhou -c user.email=188980047+changbaizhou@users.noreply.github.com commit --author="changbaizhou <188980047+changbaizhou@users.noreply.github.com>" -m "feat: autosave paper notes"
```

## Task 4: Recycle Bin and Safe Purge

**Files:**
- Create: `src/fileStorage.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `tests/repository.test.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Write failing repository tests for trash and restore**

Test that `trashPaper` hides a paper from normal search, `listTrashedPapers` returns it, and `restorePaper` makes it searchable again. Test that `purgePaper` removes the paper, draft link, and `paper_files` rows while returning safe stored paths for filesystem cleanup.

```js
repo.trashPaper(paperId);
assert.deepEqual(repo.searchPapers(), []);
assert.equal(repo.listTrashedPapers()[0].id, paperId);
repo.restorePaper(paperId);
assert.equal(repo.searchPapers()[0].id, paperId);
repo.trashPaper(paperId);
const purged = repo.purgePaper(paperId);
assert.equal(purged.paper.id, paperId);
assert.equal(repo.getPaper(paperId), null);
```

- [ ] **Step 2: Run repository tests and verify failure**

Run: `node --test tests/repository.test.js`

Expected: FAIL because trash methods do not exist.

- [ ] **Step 3: Implement repository trash transactions**

`trashPaper` sets `deleted_at = CURRENT_TIMESTAMP`, increments `version`, and marks attached `paper_files.status = 'trash'`. `restorePaper` clears `deleted_at`, increments `version`, and returns file rows to `active`. `searchPapers` excludes deleted and merged rows. `listTrashedPapers` orders by deletion time descending. `purgePaper` requires the paper already be trashed, deletes file rows and the paper in one transaction, and returns the stored paths after commit.

- [ ] **Step 4: Implement safe file resolution**

In `src/fileStorage.js`, export `resolveLibraryPdf(filesDir, storedPath)` and `removeLibraryFiles(filesDir, storedPaths)`. Resolve both roots, reject paths outside `filesDir`, require `.pdf`, deduplicate paths, and use `rmSync(path, { force: true })`. Return `{ removed, rejected, missing }` so the API can report partial filesystem cleanup without exposing absolute paths.

- [ ] **Step 5: Add and test trash APIs**

Add:

- `DELETE /api/papers/:id` to move a paper to trash.
- `GET /api/trash` to list trashed papers.
- `POST /api/trash/:id/restore` to restore.
- `DELETE /api/trash/:id` with body `{ "confirm": true }` to purge and then remove safe PDF paths.
- `DELETE /api/trash` with body `{ "confirm": true }` to purge every trashed paper using the same guarded cleanup.

API tests must assert `400` without confirmation, `404` for unknown IDs, and that a test PDF remains after trash but is gone after individual or full-bin purge.

- [ ] **Step 6: Run focused tests**

Run: `node --test tests/repository.test.js tests/api.test.js`

Expected: PASS for trash, restore, purge, and source PDF behavior.

- [ ] **Step 7: Commit recycle-bin support**

```powershell
git add src/fileStorage.js src/repository.js src/server.js tests/repository.test.js tests/api.test.js
git -c user.name=changbaizhou -c user.email=188980047+changbaizhou@users.noreply.github.com commit --author="changbaizhou <188980047+changbaizhou@users.noreply.github.com>" -m "feat: add paper recycle bin"
```

## Task 5: File Fingerprints and Duplicate Candidates

**Files:**
- Create: `src/duplicates.js`
- Modify: `src/migrations.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `tests/database.test.js`
- Create: `tests/duplicates.test.js`
- Modify: `tests/repository.test.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Write failing duplicate utility tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintBuffer, normalizeDoi, normalizeTitle, titleSimilarity } from "../src/duplicates.js";

test("duplicate helpers normalize identifiers and rank near-identical titles", () => {
  assert.equal(fingerprintBuffer(Buffer.from("paper")), "382635c9325bf3273d195ff1b8a44e5b11afd7d97addeb8863ea35feb98c1a07");
  assert.equal(normalizeDoi("https://doi.org/10.1000/ABC. "), "10.1000/abc");
  assert.equal(normalizeTitle("Loess–Palaeosol: Record"), "loess palaeosol record");
  assert.ok(titleSimilarity("Holocene lake sediment record", "A Holocene lake-sediment record") >= 0.9);
  assert.ok(titleSimilarity("Holocene lake sediment record", "Marine terrace chronology") < 0.5);
});
```

- [ ] **Step 2: Run duplicate tests and verify module failure**

Run: `node --test tests/duplicates.test.js`

Expected: FAIL because `src/duplicates.js` does not exist.

- [ ] **Step 3: Implement deterministic duplicate helpers**

Use `createHash("sha256")`, Unicode NFKC normalization, DOI URL removal, punctuation folding, removal of leading English articles `a`, `an`, and `the`, and Sørensen-Dice similarity over normalized title word bigrams. Empty titles must return similarity 0; identical normalized titles return 1.

- [ ] **Step 4: Store fingerprints and duplicate candidates during upload**

Before writing each upload, calculate `fingerprintBuffer(file.buffer)`. Pass `fileSha256` into the draft. After local/remote metadata is assembled, call:

```js
repo.findDuplicatePapers({
  sha256: fileSha256,
  doi: metadata.doi,
  title: metadata.title,
  year: metadata.year
});
```

Candidate priority is exact SHA-256, exact normalized DOI, then title similarity at least 0.92 with matching year or a missing year. Save compact candidates as `{ paperId, reason, score, title, year, doi }`. On draft confirmation, copy the hash to `papers`, update normalized DOI/title, attach the draft file row to the new paper, and retain duplicate candidates only in the draft audit record.

Add migration 2 in `src/migrations.js` to backfill `normalized_doi` and `normalized_title` for existing papers using the same helpers. Update the migration test to expect versions `[1, 2]` and assert the legacy paper receives normalized values. Do not hash files inside a schema migration.

- [ ] **Step 5: Add API tests for exact and metadata duplicates**

Upload the same PDF twice and assert the second draft includes a `sha256` candidate. Create another paper with the same DOI but different bytes and assert an exact DOI candidate. Confirming a duplicate as a separate paper must still be allowed because human confirmation is authoritative.

Add `POST /api/duplicates/scan`. It must enumerate active `paper_files` with missing hashes, resolve each path through `resolveLibraryPdf`, calculate hashes sequentially, persist them, refresh parent paper hashes, and return grouped exact-hash, DOI, and title candidates. Add `GET /api/duplicates` to return the latest groups without rescanning. Tests must use only temporary files and assert paths outside the configured file root are rejected rather than read.

Add `DELETE /api/drafts/:id` with body `{ "confirm": true }` for abandoning a duplicate upload. It must only delete pending drafts, remove their `paper_files` rows in a transaction, and then remove only safely resolved local PDFs. Tests must prove a confirmed or merged draft cannot be deleted through this endpoint.

- [ ] **Step 6: Run duplicate, repository, and API tests**

Run: `node --test tests/duplicates.test.js tests/repository.test.js tests/api.test.js`

Expected: PASS with candidate reasons in deterministic priority order.

- [ ] **Step 7: Commit duplicate detection**

```powershell
git add src/duplicates.js src/migrations.js src/repository.js src/server.js tests/database.test.js tests/duplicates.test.js tests/repository.test.js tests/api.test.js
git -c user.name=changbaizhou -c user.email=188980047+changbaizhou@users.noreply.github.com commit --author="changbaizhou <188980047+changbaizhou@users.noreply.github.com>" -m "feat: detect duplicate papers"
```

## Task 6: Database and Full Library Backups

**Files:**
- Create: `src/backups.js`
- Modify: `src/config.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Create: `tests/backups.test.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Write failing backup tests**

Create a temporary database and PDF, then assert database and full backups have manifests and hashes. Modify the live database, restore the backup, reinitialize it, and assert the original paper returns.

```js
const record = createDatabaseBackup({ dbPath, backupsDir, reason: "test" });
assert.equal(record.backupType, "database");
assert.ok(existsSync(record.databasePath));
assert.ok(validateBackup(record.manifestPath).valid);

const full = createFullBackup({ dbPath, filesDir, backupsDir });
assert.equal(full.backupType, "full");
assert.ok(existsSync(path.join(full.directoryPath, "files", "paper.pdf")));

restoreBackup({ dbPath, filesDir, backupDirectory: full.directoryPath });
initDb(dbPath);
assert.equal(new PaperRepository(dbPath).searchPapers()[0].title, "Backup paper");
```

- [ ] **Step 2: Run backup tests and verify module failure**

Run: `node --test tests/backups.test.js`

Expected: FAIL because `src/backups.js` does not exist.

- [ ] **Step 3: Implement backup creation and manifests**

Use only Node built-ins. A backup directory is `library/backups/<UTC timestamp>-<type>/` and contains `library.sqlite`, `manifest.json`, and `README.txt`; full backups additionally contain `files/`. Before copying the database, open it and execute `PRAGMA wal_checkpoint(FULL)` when supported, then close it. Hash every copied file with SHA-256 and store relative path, size, and hash in the manifest. The README must describe restore contents without environment variables or secrets.

Add `backupsDir` to `defaultConfig`. In `createApp`, derive it as `options.backupsDir ?? path.join(path.dirname(config.dbPath), "backups")`, call `initDb(config.dbPath, { backupsDir: config.backupsDir })`, and ensure tests using a temporary database never write into the real `library/backups/`. Update the `withServer` test helper to pass `path.join(dir, "backups")` explicitly.

Database backups copy only SQLite. Full backups use `cpSync(filesDir, targetFilesDir, { recursive: true })`. `validateBackup` rejects absolute manifest paths, `..` traversal, missing files, size differences, and hash differences.

- [ ] **Step 4: Implement guarded restoration**

`restoreBackup` must validate first, create a pre-restore database backup, copy the current database and files into an internal rollback directory, replace them from the selected backup, run `initDb`, and remove the rollback directory only on success. On any error, restore the rollback copy and rethrow. Only paths returned from `repo.getBackupRecord(id)` and contained inside `backupsDir` are accepted by the API.

- [ ] **Step 5: Add backup repository records and APIs**

Add repository methods `createBackupRecord`, `listBackupRecords`, and `getBackupRecord`. Add:

- `GET /api/backups`
- `POST /api/backups` with `{ "type": "database" | "full" }`
- `POST /api/backups/:id/restore` with `{ "confirm": true }`

At application startup, create an `automatic` database backup only when the newest automatic record is older than 24 hours, then delete automatic backup folders and their records beyond the newest 30. Manual, pre-migration, pre-restore, and pre-merge backups are never removed by this retention rule. Inject `now` into the backup scheduler in tests so the 24-hour and 30-copy behavior is deterministic.

Creating a merge or starting a bulk migration must call the same database backup function. API tests must reject unknown types, missing confirmation, invalid manifests, and paths outside the backup root.

- [ ] **Step 6: Run backup and API tests**

Run: `node --test tests/backups.test.js tests/api.test.js`

Expected: PASS for valid create/restore and all rejection cases.

- [ ] **Step 7: Commit backup support**

```powershell
git add src/backups.js src/config.js src/repository.js src/server.js tests/backups.test.js tests/api.test.js
git -c user.name=changbaizhou -c user.email=188980047+changbaizhou@users.noreply.github.com commit --author="changbaizhou <188980047+changbaizhou@users.noreply.github.com>" -m "feat: add local backup and restore"
```

## Task 7: Safe Duplicate Merging

**Files:**
- Modify: `src/paperData.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `tests/repository.test.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Write failing merge tests**

Create target and source papers with complementary metadata, different keyword arrays, distinct notes, progress, bookmarks, and file rows. Assert the merge result:

```js
const merged = repo.mergePapers({ targetPaperId, sourcePaperId, backupRecordId: 7 });
assert.equal(merged.id, targetPaperId);
assert.ok(merged.keywords.includes("loess"));
assert.ok(merged.keywords.includes("palaeosol"));
assert.match(merged.notesPersonal, /Target note/);
assert.match(merged.notesPersonal, /Source note/);
assert.equal(merged.lastReadPage, 8);
assert.equal(repo.getPaper(sourcePaperId).mergedIntoId, targetPaperId);
assert.equal(repo.searchPapers().length, 1);
assert.equal(repo.listPaperFiles(targetPaperId).length, 2);
```

- [ ] **Step 2: Run repository tests and verify failure**

Run: `node --test tests/repository.test.js`

Expected: FAIL because merge methods do not exist.

- [ ] **Step 3: Implement deterministic merge rules**

In `src/paperData.js`, add helpers with these rules:

- Keep the target scalar value when non-empty; otherwise use source.
- Merge arrays in target-first order with case-insensitive deduplication.
- Keep target bookmark when set; otherwise source bookmark.
- Use the greater last-read page.
- Rank reading status as `must-read`, `reading`, `method-reference`, `read`, `to-read`.
- For two different non-empty note values, join them with `\n\n--- 合并自另一条论文记录 ---\n\n`.

`mergePapers` must run in one `BEGIN IMMEDIATE` transaction, require distinct active papers, update target search text and version, move all source `paper_files` to target, set source `merged_into_id` and `deleted_at`, and write `paper_merge_log` with field decisions and the backup record ID.

- [ ] **Step 4: Add guarded merge APIs**

Add `POST /api/papers/:id/merge` with:

```json
{
  "sourcePaperId": 12,
  "confirm": true
}
```

The route must create a database backup before calling `mergePapers`. Return `400` for same IDs or missing confirmation, `404` for missing papers, and `409` for already deleted/merged papers. Add `POST /api/drafts/:id/merge` to confirm a duplicate draft into an existing target without creating a second paper; it attaches the draft PDF as another file, fills only empty target fields, marks the draft `merged`, and records a merge log.

- [ ] **Step 5: Run merge, backup, and API tests**

Run: `node --test tests/repository.test.js tests/backups.test.js tests/api.test.js`

Expected: PASS and every successful merge has a preceding backup record.

- [ ] **Step 6: Commit merge support**

```powershell
git add src/paperData.js src/repository.js src/server.js tests/repository.test.js tests/api.test.js
git -c user.name=changbaizhou -c user.email=188980047+changbaizhou@users.noreply.github.com commit --author="changbaizhou <188980047+changbaizhou@users.noreply.github.com>" -m "feat: merge duplicate paper records"
```

## Task 8: Duplicate, Trash, and Backup UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/uiStructure.test.js`

- [ ] **Step 1: Write failing UI structure tests**

Assert the presence of library/trash/maintenance view controls, duplicate candidates, restore/purge actions, backup type controls, and the exact API route strings:

```js
assert.match(html, /id="libraryViewButton"/);
assert.match(html, /id="trashViewButton"/);
assert.match(html, /id="maintenanceViewButton"/);
assert.match(html, /id="duplicateCandidates"/);
assert.match(html, /id="trashList"/);
assert.match(html, /id="backupList"/);
assert.match(script, /\/api\/trash/);
assert.match(script, /\/api\/backups/);
assert.match(script, /\/merge/);
```

- [ ] **Step 2: Run UI tests and verify failure**

Run: `node --test tests/uiStructure.test.js`

Expected: FAIL because maintenance views do not exist.

- [ ] **Step 3: Add compact workspace navigation**

Add three icon-and-text controls in the existing header: `论文库`, `回收站`, `维护`. The default remains the real paper library. Reuse the center workspace for trash and maintenance views; do not add a landing page or marketing content.

The trash view lists title, deletion time, restore, and purge, plus a `清空回收站` command. Purge and empty-bin actions open a native dialog that requires a second explicit click. After restore or purge, reload papers and trash counts.

The maintenance view lists backup type, time, size, validation state, and restore. Provide `备份数据库`, `完整备份`, and `扫描重复论文` commands. Restore requires confirmation and shows a blocking progress state until the health endpoint responds again.

- [ ] **Step 4: Add duplicate review to draft confirmation**

When `draft.duplicateCandidates` is non-empty, show a warning section with reason labels `文件完全相同`, `DOI 相同`, or `题名高度相似`. Each candidate exposes `打开已有论文`, `合并到此论文`, `放弃此次上传`, and the existing `仍然单独入库` confirmation. The default action remains review; no automatic merge or deletion occurs.

- [ ] **Step 5: Style and verify stable layouts**

Use the current restrained palette, 8px-or-less radii, fixed-height action bars, and scrollable lists. At 1366×768, the duplicate actions must wrap without overlapping the detail form. At 390×844, navigation and maintenance controls must remain readable and not overflow horizontally.

- [ ] **Step 6: Run UI and API tests**

Run: `node --test tests/uiStructure.test.js tests/api.test.js`

Expected: PASS for structure and endpoint contracts.

- [ ] **Step 7: Commit maintenance UI**

```powershell
git add public/index.html public/app.js public/styles.css tests/uiStructure.test.js
git -c user.name=changbaizhou -c user.email=188980047+changbaizhou@users.noreply.github.com commit --author="changbaizhou <188980047+changbaizhou@users.noreply.github.com>" -m "feat: add library maintenance workspace"
```

## Task 9: Migration Rehearsal, Browser Verification, and Documentation

**Files:**
- Modify: `README.md`
- Modify: `tests/startScript.test.js`
- Create: `playwright.config.js`
- Create: `tests/browser/dataFoundation.spec.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add a real browser smoke test**

Install the browser-test dependencies and Chromium:

```powershell
npm install --save-dev @playwright/test pdf-lib
npx playwright install chromium
```

Add `"test:browser": "playwright test"` to `package.json`. Configure `playwright.config.js` with `testDir: "tests/browser"`, one worker, Chromium only, screenshots on failure, and a 30-second test timeout.

The smoke test must create a temporary server in `beforeAll`, pass temporary `dbPath`, `filesDir`, and `backupsDir`, and generate a valid one-page PDF with `pdf-lib`:

```js
const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const font = await pdf.embedFont(StandardFonts.Helvetica);
page.drawText("Holocene lake sediment record", { x: 72, y: 760, size: 18, font });
page.drawText("Abstract", { x: 72, y: 720, size: 12, font });
page.drawText("This paper records Holocene climate change.", { x: 72, y: 700, size: 11, font });
await writeFile(pdfPath, await pdf.save());
```

Use Playwright locators by ID or accessible role, never timing-only selectors. The smoke test must verify this sequence:

1. Upload and confirm a PDF fixture.
2. Edit the confirmed title and reload the page.
3. Change a note, wait for `已保存`, and reload.
4. Trash and restore the paper.
5. Upload the same bytes and see an exact-file duplicate warning.
6. Create and validate a database backup.
7. Open the PDF reader, return, and open it again.

Run the workflow once at 1366×768, capture a screenshot, inspect the PDF canvas with `getImageData`, and assert it contains non-white pixels. Run a second layout test at 390×844 that checks every visible button, input, and select bounding box remains inside the viewport and capture a second screenshot.

- [ ] **Step 2: Document the completed workflows**

Rewrite the affected README sections in valid UTF-8 Chinese. Document explicit metadata save, note autosave, duplicate review, recycle bin, backup locations, full-backup contents, restore confirmation, and the fact that `local.env.bat` is never included in backups or Git.

- [ ] **Step 3: Rehearse migration against a copy of the real library**

Stop the local server, copy `library/library.sqlite` to a temporary verification directory, run `initDb` against the copy, and compare before/after counts for drafts and papers plus title, DOI, stored path, bookmark, and notes fields. Do not modify or print the contents of `local.env.bat`.

Expected: counts and existing field values are unchanged; only migration columns, tables, normalized values, and file records are added.

- [ ] **Step 4: Run complete verification**

Run:

```powershell
npm test
npm run test:browser
git diff --check
git status --short
git diff --cached --no-ext-diff
git log -10 --pretty=format:"%h %an <%ae> %s"
```

Expected: all tests pass, `git diff --check` is clean, only intended files are modified, every displayed author is `changbaizhou <188980047+changbaizhou@users.noreply.github.com>`, and manual staged-diff inspection shows no credential value, PDF, SQLite file, or local environment file.

- [ ] **Step 5: Manually verify the one-click launcher**

Stop any test server, double-click `启动论文库.bat`, open `http://127.0.0.1:8000`, and repeat edit, autosave, trash/restore, duplicate review, backup, and reader-return workflows against test records. Confirm translation still uses Qwen and no key appears in the browser, terminal output, or application logs.

- [ ] **Step 6: Commit documentation and browser verification**

```powershell
git add README.md package.json package-lock.json playwright.config.js tests/startScript.test.js tests/browser/dataFoundation.spec.js
git -c user.name=changbaizhou -c user.email=188980047+changbaizhou@users.noreply.github.com commit --author="changbaizhou <188980047+changbaizhou@users.noreply.github.com>" -m "test: verify library data foundation"
```

- [ ] **Step 7: Verify commit history and push**

Run:

```powershell
git log -10 --pretty=format:"%h %an <%ae> %s"
git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 push origin main
```

Expected: every new commit is authored by `changbaizhou <188980047+changbaizhou@users.noreply.github.com>` and `main` is pushed successfully.
