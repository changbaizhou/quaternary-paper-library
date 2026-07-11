import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { initDb, openDb } from "../src/database.js";
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
      assert.equal(row.normalized_title, "a study café 研究");
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
