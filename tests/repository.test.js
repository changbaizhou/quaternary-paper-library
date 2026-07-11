import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { initDb } from "../src/database.js";
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
