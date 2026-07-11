import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { initDb, openDb } from "../src/database.js";
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
