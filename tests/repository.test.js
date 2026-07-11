import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { initDb, openDb } from "../src/database.js";
import { normalizeTitle } from "../src/duplicates.js";
import { removeLibraryFiles } from "../src/fileStorage.js";
import { PaperRepository } from "../src/repository.js";

test("draft confirm and search workflow", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-repo-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);

    const draftId = repo.createDraft({
      originalFilename: "paper.pdf",
      storedFilename: "li-2026-holocene.pdf",
      storedPath: "library/files/2026/li-2026-holocene.pdf",
      doi: "10.1000/test",
      title: "Holocene lake sediment record",
      authors: ["Li Wei", "Zhang Min"],
      journal: "Quaternary Science Reviews",
      year: 2026,
      abstract: "A pollen and lake sediment record from the Qinghai-Tibet Plateau.",
      authorKeywords: ["Holocene", "lake sediment"],
      suggestedKeywords: ["pollen"],
      classification: {
        themes: ["lake sediment"],
        regions: ["Qinghai-Tibet Plateau"],
        periods: ["Holocene"],
        materials: ["lake core"],
        methods: ["pollen"],
        proxies: ["pollen"]
      },
      confidence: {},
      evidence: {},
      extractedText: "Holocene lake sediment pollen Qinghai-Tibet Plateau"
    });

    const pending = repo.listPendingDrafts();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, draftId);

    const paperId = repo.confirmDraft(draftId, {
      readingStatus: "to-read",
      notesCoreFindings: "Monsoon variability is reconstructed."
    });

    assert.deepEqual(repo.listPendingDrafts(), []);
    const results = repo.searchPapers({
      query: "monsoon",
      filters: { regions: ["Qinghai-Tibet Plateau"] }
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, paperId);
    assert.equal(results[0].title, "Holocene lake sediment record");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository stores one bookmark and last read page per paper", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-repo-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);

    const draftId = repo.createDraft({
      originalFilename: "reader.pdf",
      title: "Reader progress paper",
      abstract: "A paper used to test reading progress.",
      classification: {},
      confidence: {},
      evidence: {}
    });
    const paperId = repo.confirmDraft(draftId);

    let paper = repo.updateReadingProgress(paperId, { lastReadPage: 4 });
    assert.equal(paper.lastReadPage, 4);
    assert.equal(paper.bookmarkPage, null);

    paper = repo.updateReadingProgress(paperId, { bookmarkPage: 8 });
    assert.equal(paper.lastReadPage, 4);
    assert.equal(paper.bookmarkPage, 8);

    paper = repo.updateReadingProgress(paperId, { bookmarkPage: 3 });
    assert.equal(paper.bookmarkPage, 3);
    assert.equal(repo.getPaper(paperId).bookmarkPage, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository moves papers through trash, restore, and purge", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-repo-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({
      originalFilename: "trash.pdf",
      storedFilename: "trash.pdf",
      storedPath: "files/2026/trash.pdf",
      title: "Paper for recycle bin",
      classification: {},
      confidence: {},
      evidence: {}
    });
    const paperId = repo.confirmDraft(draftId);

    const active = repo.getPaper(paperId);
    repo.trashPaper(paperId);
    assert.deepEqual(repo.searchPapers(), []);
    assert.equal(repo.listTrashedPapers()[0].id, paperId);
    assert.equal(repo.getPaper(paperId).version, active.version + 1);

    const trashedFiles = openDb(dbPath);
    try {
      assert.equal(trashedFiles.prepare("SELECT status FROM paper_files WHERE paper_id = ?").get(paperId).status, "trash");
    } finally {
      trashedFiles.close();
    }

    repo.restorePaper(paperId);
    assert.equal(repo.searchPapers()[0].id, paperId);
    assert.equal(repo.getPaper(paperId).version, active.version + 2);

    const restoredFiles = openDb(dbPath);
    try {
      assert.equal(restoredFiles.prepare("SELECT status FROM paper_files WHERE paper_id = ?").get(paperId).status, "active");
    } finally {
      restoredFiles.close();
    }

    repo.trashPaper(paperId);
    const purged = repo.purgePaper(paperId);
    assert.equal(purged.paper.id, paperId);
    assert.deepEqual(purged.storedPaths, ["files/2026/trash.pdf"]);
    assert.equal(repo.getPaper(paperId), null);

    const afterPurge = openDb(dbPath);
    try {
      assert.equal(afterPurge.prepare("SELECT COUNT(*) AS count FROM paper_files WHERE paper_id = ?").get(paperId).count, 0);
      assert.equal(afterPurge.prepare("SELECT source_draft_id FROM papers WHERE id = ?").get(paperId), undefined);
    } finally {
      afterPurge.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository purges all trashed papers in one operation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-repo-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const makePaper = (title, storedPath) => {
      const draftId = repo.createDraft({
        title,
        storedPath,
        classification: {},
        confidence: {},
        evidence: {}
      });
      return repo.confirmDraft(draftId);
    };
    const firstId = makePaper("First trashed paper", "2026/first.pdf");
    const secondId = makePaper("Second trashed paper", "2026/second.pdf");
    repo.trashPaper(firstId);
    repo.trashPaper(secondId);

    const purged = repo.purgeAllTrashedPapers();
    assert.deepEqual(purged.papers.map((paper) => paper.id).sort(), [firstId, secondId].sort());
    assert.deepEqual(purged.storedPaths.sort(), ["2026/first.pdf", "2026/second.pdf"]);
    assert.deepEqual(purged.protectedStoredPaths, []);
    assert.equal(repo.getPaper(firstId), null);
    assert.equal(repo.getPaper(secondId), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository rejects merged records from purge and editing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-repo-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({ title: "Merged paper", classification: {}, confidence: {}, evidence: {} });
    const paperId = repo.confirmDraft(draftId);
    const db = openDb(dbPath);
    try {
      db.prepare("UPDATE papers SET deleted_at = CURRENT_TIMESTAMP, merged_into_id = 999 WHERE id = ?").run(paperId);
    } finally {
      db.close();
    }

    assert.throws(() => repo.purgePaper(paperId), /Merged paper cannot be purged/);
    assert.throws(() => repo.purgeAllTrashedPapers(), /Merged paper cannot be purged/);
    assert.throws(
      () => repo.updatePaper(paperId, { expectedVersion: 1, title: "Blocked merged edit" }),
      /Paper must be active before editing/
    );
    assert.throws(
      () => repo.updateReadingProgress(paperId, { lastReadPage: 2 }),
      /Paper must be active before updating reading progress/
    );
    assert.equal(repo.getPaper(paperId).title, "Merged paper");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository rejects edits while a paper is trashed until restore", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-repo-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({ title: "Trashed paper", classification: {}, confidence: {}, evidence: {} });
    const paperId = repo.confirmDraft(draftId);
    repo.trashPaper(paperId);

    assert.throws(
      () => repo.updatePaper(paperId, { expectedVersion: 2, title: "Blocked trashed edit" }),
      /Paper must be active before editing/
    );
    assert.throws(
      () => repo.updateReadingProgress(paperId, { lastReadPage: 2 }),
      /Paper must be active before updating reading progress/
    );

    repo.restorePaper(paperId);
    assert.equal(repo.updatePaper(paperId, { expectedVersion: 3, title: "Restored edit" }).title, "Restored edit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository rolls back createDraft when paper file attachment fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-repo-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const db = openDb(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER reject_draft_file BEFORE INSERT ON paper_files
        WHEN NEW.draft_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected draft file failure'); END;
      `);
    } finally {
      db.close();
    }

    const repo = new PaperRepository(dbPath);
    assert.throws(
      () => repo.createDraft({ title: "Atomic draft", storedPath: "2026/atomic.pdf" }),
      /injected draft file failure/
    );
    const afterFailure = openDb(dbPath);
    try {
      assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM drafts").get().count, 0);
      assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM paper_files").get().count, 0);
    } finally {
      afterFailure.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository rolls back confirmDraft when paper file attachment fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-repo-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({ title: "Atomic confirmation", storedPath: "2026/atomic.pdf" });
    const db = openDb(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER reject_paper_file BEFORE UPDATE OF paper_id ON paper_files
        WHEN NEW.paper_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected paper file failure'); END;
      `);
    } finally {
      db.close();
    }

    assert.throws(() => repo.confirmDraft(draftId), /injected paper file failure/);
    const afterFailure = openDb(dbPath);
    try {
      assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM papers").get().count, 0);
      assert.equal(afterFailure.prepare("SELECT status FROM drafts WHERE id = ?").get(draftId).status, "pending");
      assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM paper_files WHERE draft_id = ?").get(draftId).count, 1);
    } finally {
      afterFailure.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage removes only safe PDF paths", async () => {
  const { removeLibraryFiles, resolveLibraryPdf } = await import("../src/fileStorage.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-files-"));

  try {
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(path.join(dir, "2026"), { recursive: true }).then(() =>
        writeFile(path.join(dir, "2026", "source.pdf"), "%PDF-1.4")
      )
    );

    assert.equal(resolveLibraryPdf(dir, "2026/source.pdf"), path.join(dir, "2026", "source.pdf"));
    assert.equal(resolveLibraryPdf(dir, "../outside.pdf"), null);
    assert.equal(resolveLibraryPdf(dir, "2026/source.txt"), null);

    const cleanup = removeLibraryFiles(dir, [
      "2026/source.pdf",
      "2026/source.pdf",
      "2026/missing.pdf",
      "../outside.pdf",
      "2026/source.txt"
    ]);
    assert.equal(cleanup.removed.length, 1);
    assert.equal(cleanup.missing.length, 1);
    assert.equal(cleanup.rejected.length, 2);
    assert.ok([...cleanup.rejected, ...cleanup.missing, ...cleanup.removed].every((value) => !path.isAbsolute(value)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage reports rm failures without deleting the orphan", async () => {
  const { removeLibraryFiles } = await import("../src/fileStorage.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-files-"));

  try {
    await mkdir(path.join(dir, "2026"), { recursive: true });
    const pdfPath = path.join(dir, "2026", "locked.pdf");
    await writeFile(pdfPath, "%PDF-1.4");
    const cleanup = removeLibraryFiles(
      dir,
      ["2026/locked.pdf"],
      [],
      {
        removeFile: () => {
          const error = new Error(`EACCES ${pdfPath}`);
          error.code = "EACCES";
          throw error;
        }
      }
    );

    assert.deepEqual(cleanup.removed, []);
    assert.deepEqual(cleanup.failed, ["2026/locked.pdf"]);
    assert.equal(cleanup.failedCount, 1);
    assert.equal(JSON.stringify(cleanup).includes(dir), false);
    await access(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage protects canonical aliases referenced by surviving papers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-shared-"));
  const filesDir = path.join(dir, "files");
  const dbPath = path.join(dir, "library.sqlite");

  try {
    await mkdir(path.join(filesDir, "2026"), { recursive: true });
    const pdfPath = path.join(filesDir, "2026", "shared.pdf");
    await writeFile(pdfPath, "%PDF-1.4 shared");
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const relativePath = path.relative(process.cwd(), pdfPath);
    const dotPath = `${filesDir}${path.sep}2026${path.sep}.${path.sep}shared.pdf`;

    const firstDraft = repo.createDraft({
      storedPath: relativePath,
      storedFilename: "shared.pdf",
      title: "First shared paper",
      classification: {},
      confidence: {},
      evidence: {}
    });
    const secondDraft = repo.createDraft({
      storedPath: dotPath,
      storedFilename: "shared.pdf",
      title: "Second shared paper",
      classification: {},
      confidence: {},
      evidence: {}
    });
    const casePath = `${filesDir}${path.sep}2026${path.sep}SHARED.PDF`;
    let caseDraftId = null;
    if (process.platform === "win32") {
      caseDraftId = repo.createDraft({
        storedPath: casePath,
        storedFilename: "SHARED.PDF",
        title: "Case alias paper",
        classification: {},
        confidence: {},
        evidence: {}
      });
    }
    const firstPaperId = repo.confirmDraft(firstDraft);
    const secondPaperId = repo.confirmDraft(secondDraft);
    const casePaperId = caseDraftId === null ? null : repo.confirmDraft(caseDraftId);

    repo.trashPaper(firstPaperId);
    const purgedFirst = repo.purgePaper(firstPaperId);
    assert.ok(purgedFirst.storedPaths.includes(relativePath));
    assert.ok(purgedFirst.protectedStoredPaths.includes(dotPath));
    if (casePaperId !== null) assert.ok(purgedFirst.protectedStoredPaths.includes(casePath));
    const firstCleanup = removeLibraryFiles(filesDir, purgedFirst.storedPaths, purgedFirst.protectedStoredPaths);
    assert.deepEqual(firstCleanup.removed, []);
    assert.ok(firstCleanup.rejected.length === 0);
    await access(pdfPath);

    repo.trashPaper(secondPaperId);
    const purgedSecond = repo.purgePaper(secondPaperId);
    const secondCleanup = removeLibraryFiles(filesDir, purgedSecond.storedPaths, purgedSecond.protectedStoredPaths);
    if (casePaperId === null) {
      assert.deepEqual(secondCleanup.removed, ["2026/shared.pdf"]);
    } else {
      assert.deepEqual(secondCleanup.removed, []);
      repo.trashPaper(casePaperId);
      const purgedCase = repo.purgePaper(casePaperId);
      const caseCleanup = removeLibraryFiles(filesDir, purgedCase.storedPaths, purgedCase.protectedStoredPaths);
      assert.deepEqual(caseCleanup.removed, ["2026/shared.pdf"]);
    }
    await assert.rejects(access(pdfPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository updates confirmed papers and rejects stale versions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-repo-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({
      title: "Holocene record",
      classification: {},
      confidence: {},
      evidence: {}
    });
    const paperId = repo.confirmDraft(draftId);

    const updated = repo.updatePaper(paperId, {
      expectedVersion: 1,
      doi: "https://doi.org/10.1000/UPDATED.",
      title: "Ａ Study: Café—研究!",
      notesCoreFindings: "The revised note is searchable."
    });

    assert.equal(updated.version, 2);
    assert.equal(updated.title, "Ａ Study: Café—研究!");
    assert.equal(repo.searchPapers({ query: "revised note" })[0].id, paperId);

    const db = openDb(dbPath);
    try {
      const row = db
        .prepare("SELECT search_text, normalized_doi, normalized_title FROM papers WHERE id = ?")
        .get(paperId);
      assert.equal(row.search_text, "ａ study: café—研究! https://doi.org/10.1000/updated. the revised note is searchable.");
      assert.equal(row.normalized_doi, "10.1000/updated");
      assert.equal(row.normalized_title, "study café 研究");
    } finally {
      db.close();
    }

    const beforeNoop = repo.getPaper(paperId);
    assert.throws(
      () => repo.updatePaper(paperId, { expectedVersion: beforeNoop.version }),
      (error) => error instanceof TypeError
    );
    const afterNoop = repo.getPaper(paperId);
    assert.equal(afterNoop.version, beforeNoop.version);
    assert.equal(afterNoop.updatedAt, beforeNoop.updatedAt);

    assert.throws(
      () => repo.updatePaper(paperId, { expectedVersion: 1, title: "Stale edit" }),
      (error) => error.name === "VersionConflictError"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository ranks duplicate candidates by hash, DOI, then title", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-duplicates-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const createPaper = (input) => repo.confirmDraft(repo.createDraft({
      classification: {},
      confidence: {},
      evidence: {},
      ...input
    }));

    const shaPaperId = createPaper({
      fileSha256: "same-bytes",
      doi: "10.1000/ABC",
      title: "First paper",
      year: 2020
    });
    const doiPaperId = createPaper({
      fileSha256: "different-bytes",
      doi: "https://doi.org/10.1000/ABC.",
      title: "Different title",
      year: 2019
    });
    const titlePaperId = createPaper({
      fileSha256: "other-bytes",
      doi: "10.1000/OTHER",
      title: "The Holocene lake sediment record",
      year: 2020
    });

    assert.deepEqual(
      repo.findDuplicatePapers({
        sha256: "same-bytes",
        doi: "10.1000/ABC",
        title: "A Holocene lake sediment record",
        year: 2020
      }),
      [
        { paperId: shaPaperId, reason: "sha256", score: 1, title: "First paper", year: 2020, doi: "10.1000/ABC" },
        { paperId: doiPaperId, reason: "doi", score: 1, title: "Different title", year: 2019, doi: "https://doi.org/10.1000/ABC." },
        { paperId: titlePaperId, reason: "title", score: 1, title: "The Holocene lake sediment record", year: 2020, doi: "10.1000/OTHER" }
      ]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository deletes only pending drafts and returns their cleanup paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-draft-delete-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const pendingId = repo.createDraft({ storedPath: "2026/pending.pdf", title: "Pending" });
    const confirmedId = repo.createDraft({ storedPath: "2026/confirmed.pdf", title: "Confirmed" });
    repo.confirmDraft(confirmedId);

    const deleted = repo.deletePendingDraft(pendingId);
    assert.deepEqual(deleted.storedPaths, ["2026/pending.pdf"]);
    assert.equal(repo.getDraft(pendingId), null);
    assert.throws(() => repo.deletePendingDraft(confirmedId), /pending/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository confirms a missing draft with DraftNotFoundError", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-missing-draft-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    assert.throws(
      () => repo.confirmDraft(999999),
      (error) => error.name === "DraftNotFoundError"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository merges complementary paper data, files, and traceability in one operation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-paper-merge-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const createPaper = (input) => repo.confirmDraft(repo.createDraft({
      classification: {},
      confidence: {},
      evidence: {},
      ...input
    }), input);
    const targetId = createPaper({
      storedFilename: "target.pdf",
      storedPath: "2026/target.pdf",
      title: "Target title",
      authors: ["Alice"],
      keywords: ["Climate", "climate"],
      abstract: "",
      readingStatus: "to-read",
      notesCoreFindings: "Target note"
    });
    const sourceId = createPaper({
      storedFilename: "source.pdf",
      storedPath: "2026/source.pdf",
      title: "Source title",
      authors: ["alice", "Bob"],
      keywords: ["CLIMATE", "Proxy"],
      abstract: "Source abstract",
      readingStatus: "must-read",
      notesCoreFindings: "Source note"
    });
    repo.updateReadingProgress(targetId, { lastReadPage: 4 });
    repo.updateReadingProgress(sourceId, { lastReadPage: 9, bookmarkPage: 12 });
    const backup = repo.createBackupRecord({
      backupType: "database",
      storedPath: path.join(dir, "backup"),
      createdAt: new Date().toISOString()
    });

    const merged = repo.mergePapers(targetId, sourceId, backup.id);

    assert.equal(merged.title, "Target title");
    assert.equal(merged.abstract, "Source abstract");
    assert.deepEqual(merged.authors, ["Alice", "Bob"]);
    assert.deepEqual(merged.keywords, ["Climate", "Proxy"]);
    assert.equal(merged.readingStatus, "must-read");
    assert.equal(merged.notesCoreFindings, "Target note\n\n--- 合并自另一篇论文记录 ---\n\nSource note");
    assert.equal(merged.lastReadPage, 9);
    assert.equal(merged.bookmarkPage, 12);

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_files WHERE paper_id = ?").get(targetId).count, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_files WHERE paper_id = ?").get(sourceId).count, 0);
      const source = db.prepare("SELECT deleted_at, merged_into_id FROM papers WHERE id = ?").get(sourceId);
      assert.equal(source.merged_into_id, targetId);
      assert.ok(source.deleted_at);
      const log = db.prepare("SELECT backup_record_id, summary_json FROM paper_merge_log WHERE target_paper_id = ?").get(targetId);
      assert.equal(log.backup_record_id, backup.id);
      assert.match(log.summary_json, /abstract/);
    } finally {
      db.close();
    }
    assert.equal(repo.searchPapers().some((paper) => paper.id === sourceId), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository merges a pending duplicate draft into an active paper without creating a paper", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-draft-merge-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const targetId = repo.confirmDraft(repo.createDraft({ title: "Existing target", abstract: "", classification: { regions: ["North"] }, confidence: {}, evidence: {} }));
    const draftId = repo.createDraft({
      storedFilename: "duplicate.pdf",
      storedPath: "2026/duplicate.pdf",
      title: "Draft title",
      abstract: "Draft abstract",
      authors: ["Draft author"],
      authorKeywords: ["Climate"],
      classification: { regions: ["north", "South"] },
      confidence: {},
      evidence: {}
    });
    const backup = repo.createBackupRecord({ backupType: "database", storedPath: path.join(dir, "backup") });

    const merged = repo.mergeDraft(draftId, targetId, backup.id);

    assert.equal(merged.id, targetId);
    assert.equal(merged.title, "Existing target");
    assert.equal(merged.abstract, "Draft abstract");
    assert.deepEqual(merged.regions, ["North"]);
    assert.equal(repo.searchPapers().length, 1);
    assert.equal(repo.getDraft(draftId).status, "merged");
    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_files WHERE paper_id = ? AND stored_filename = ?").get(targetId, "duplicate.pdf").count, 1);
      assert.equal(db.prepare("SELECT backup_record_id FROM paper_merge_log WHERE source_paper_id = ?").get(draftId).backup_record_id, backup.id);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository groups matching active secondary file hashes once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-hash-groups-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const createPaper = (fileSha256, title) => repo.confirmDraft(repo.createDraft({
      fileSha256,
      title,
      classification: {},
      confidence: {},
      evidence: {}
    }));
    const firstPaperId = createPaper("representative-first", "First paper");
    const secondPaperId = createPaper("representative-second", "Second paper");
    const thirdPaperId = createPaper("representative-third", "Third paper");

    const db = openDb(dbPath);
    try {
      const insertFile = db.prepare(`
        INSERT INTO paper_files (paper_id, stored_filename, stored_path, sha256, status)
        VALUES (?, ?, ?, ?, ?)
      `);
      insertFile.run(firstPaperId, "first-secondary.pdf", "2026/first-secondary.pdf", "shared-hash", "active");
      insertFile.run(firstPaperId, "first-secondary-copy.pdf", "2026/first-secondary-copy.pdf", "shared-hash", "active");
      insertFile.run(secondPaperId, "second-secondary.pdf", "2026/second-secondary.pdf", "shared-hash", "active");
      insertFile.run(thirdPaperId, "third-trash.pdf", "2026/third-trash.pdf", "shared-hash", "trash");
      insertFile.run(thirdPaperId, "third-secondary.pdf", "2026/third-secondary.pdf", "another-hash", "active");
      insertFile.run(firstPaperId, "first-other-secondary.pdf", "2026/first-other-secondary.pdf", "another-hash", "active");
    } finally {
      db.close();
    }

    assert.deepEqual(
      repo.findDuplicatePapers({ sha256: "shared-hash" }).map((candidate) => candidate.paperId),
      [firstPaperId, secondPaperId]
    );
    assert.deepEqual(repo.listDuplicateGroups().sha256, [
      { sha256: "another-hash", paperIds: [firstPaperId, thirdPaperId] },
      { sha256: "shared-hash", paperIds: [firstPaperId, secondPaperId] }
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository emits DOI and title duplicate pairs once in deterministic order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-metadata-groups-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const createPaper = (input) => repo.confirmDraft(repo.createDraft({
      classification: {},
      confidence: {},
      evidence: {},
      ...input
    }));
    const firstDoiId = createPaper({ doi: "10.1000/shared", title: "First metadata paper", year: 2020 });
    const secondDoiId = createPaper({ doi: "https://doi.org/10.1000/shared.", title: "Second metadata paper", year: 2021 });
    const firstTitleId = createPaper({ title: "Holocene lake sediment record", year: 2020 });
    const secondTitleId = createPaper({ title: "A Holocene lake sediment record", year: 2020 });

    const groups = repo.listDuplicateGroups();
    assert.deepEqual(groups.doi, [{ doi: "10.1000/shared", paperIds: [firstDoiId, secondDoiId] }]);
    assert.deepEqual(groups.title, [{
      normalizedTitle: "holocene lake sediment record",
      paperIds: [firstTitleId, secondTitleId]
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository groups more than 512 identical normalized titles directly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-title-group-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const db = openDb(dbPath);
    try {
      db.exec("BEGIN");
      const insert = db.prepare(
        "INSERT INTO papers (title, normalized_title, year, search_text) VALUES (?, ?, ?, ?)"
      );
      for (let index = 0; index < 513; index += 1) {
        insert.run("The Shared Quaternary Title", "shared quaternary title", 2020, "shared quaternary title");
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    const groups = new PaperRepository(dbPath).listDuplicateGroups();
    assert.deepEqual(groups.title, [{
      normalizedTitle: "shared quaternary title",
      paperIds: Array.from({ length: 513 }, (_, index) => index + 1)
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository groups 10,000 identical DOIs without pair expansion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-doi-group-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const db = openDb(dbPath);
    try {
      db.exec("BEGIN");
      const insert = db.prepare(`
        INSERT INTO papers (doi, normalized_doi, title, normalized_title, year, search_text)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (let index = 0; index < 10_000; index += 1) {
        const title = `DOI-only paper ${index}`;
        insert.run("10.1000/concentrated", "10.1000/concentrated", title, normalizeTitle(title), 2020, title.toLowerCase());
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    const startedAt = performance.now();
    const groups = new PaperRepository(dbPath).listDuplicateGroups();
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 3_000, `DOI grouping took ${elapsedMs.toFixed(1)}ms`);
    assert.deepEqual(groups.doi, [{
      doi: "10.1000/concentrated",
      paperIds: Array.from({ length: 10_000 }, (_, index) => index + 1)
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
