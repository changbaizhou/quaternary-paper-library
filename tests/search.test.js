import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { initDb } from "../src/database.js";
import { PaperRepository } from "../src/repository.js";
import { buildSearchQuery, tokenizeQuery } from "../src/search.js";

function createPaper(repo, input = {}) {
  const draftId = repo.createDraft({
    title: input.title || "Search paper",
    authors: input.authors || ["Author"],
    journal: "Quaternary Research",
    year: input.year || 2024,
    abstract: input.abstract || "",
    classification: input.classification || {},
    confidence: {},
    evidence: {}
  });
  const paperId = repo.confirmDraft(draftId, {
    notesCoreFindings: input.notesCoreFindings || ""
  });
  if (input.pages) repo.replacePaperPages(paperId, input.pages);
  return paperId;
}

test("buildSearchQuery quotes exact phrases, strips punctuation, and caps tokens", () => {
  const result = buildSearchQuery('"lake sediment" OR loess*; alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega');

  assert.equal(result.tokens[0].value, "lake sediment");
  assert.equal(result.tokens[0].phrase, true);
  assert.ok(result.tokens.length <= 20);
  assert.doesNotMatch(result.match, /\*|NEAR|NOT/);
  assert.match(result.match, /"lake sediment"/);
});

test("buildSearchQuery expands both Chinese and English Quaternary terms", () => {
  const chinese = buildSearchQuery("黄土");
  const english = buildSearchQuery('"lake sediment"');

  assert.ok(chinese.highlightTerms.includes("loess"));
  assert.ok(english.highlightTerms.includes("湖泊沉积"));
  assert.ok(tokenizeQuery("!!! …").length === 0);
});

test("searchLibrary returns active page hits, metadata and notes with filters", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-search-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const pagePaperId = createPaper(repo, {
      title: "Ancient loess record",
      classification: { regions: ["North"] },
      pages: [
        { pageNumber: 1, text: "Introduction", source: "pdf" },
        { pageNumber: 2, text: "The loess section contains pollen.", source: "pdf" },
        { pageNumber: 3, text: "The loess chronology is discussed.", source: "pdf" }
      ]
    });
    const metadataPaperId = createPaper(repo, {
      title: "Lake sediment metadata",
      classification: { themes: ["lake sediment"], regions: ["North"] }
    });
    const notesPaperId = createPaper(repo, {
      title: "Notes only",
      notesCoreFindings: "loess appears in the saved notes",
      classification: { regions: ["South"] }
    });
    const trashedPaperId = createPaper(repo, {
      title: "Trashed loess",
      pages: [{ pageNumber: 1, text: "loess", source: "pdf" }]
    });
    repo.trashPaper(trashedPaperId);

    const fulltext = repo.searchLibrary({ query: "loess", scope: "fulltext" });
    assert.deepEqual(fulltext.items.map((item) => [item.paperId, item.pageNumber]), [
      [pagePaperId, 2],
      [pagePaperId, 3]
    ]);
    assert.ok(fulltext.items.every((item) => item.matchScope === "fulltext"));
    assert.ok(fulltext.items.every((item) => Array.isArray(item.highlightTerms)));
    assert.equal(fulltext.total, 2);

    const metadata = repo.searchLibrary({
      query: "lake sediment",
      scope: "metadata",
      filters: { regions: ["North"] }
    });
    assert.deepEqual(metadata.items.map((item) => item.paperId), [metadataPaperId]);
    assert.equal(metadata.items[0].pageNumber, null);
    assert.equal(metadata.items[0].matchScope, "metadata");

    const notes = repo.searchLibrary({ query: "loess", scope: "notes" });
    assert.deepEqual(notes.items.map((item) => item.paperId), [notesPaperId]);

    const paged1 = repo.searchLibrary({ query: "loess", scope: "fulltext", page: 1, pageSize: 1 });
    const paged2 = repo.searchLibrary({ query: "loess", scope: "fulltext", page: 2, pageSize: 1 });
    assert.equal(paged1.total, 2);
    assert.notDeepEqual(paged1.items, paged2.items);
    assert.equal(paged1.items[0].paperId, pagePaperId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchLibrary keeps unsafe indexed text as text and supports exact phrases", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-search-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    createPaper(repo, {
      pages: [{ pageNumber: 1, text: '<img src=x onerror="alert(1)"> lake sediment', source: "pdf" }]
    });

    const result = repo.searchLibrary({ query: '"lake sediment"', scope: "fulltext" });
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].snippet, /<img src=x/);
    assert.doesNotMatch(result.items[0].snippet, /<mark>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
