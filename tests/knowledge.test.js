import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initDb, openDb } from "../src/database.js";
import { PaperRepository } from "../src/repository.js";

function createPaper(repo, { title, doi = "", regions = [], methods = [] }) {
  const draftId = repo.createDraft({
    title,
    doi,
    authors: ["Author"],
    classification: { regions, methods },
    confidence: {},
    evidence: {}
  });
  return repo.confirmDraft(draftId);
}

test("migration v8 creates knowledge, terminology, and writing tables", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-knowledge-schema-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const db = openDb(dbPath);
    try {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'paper_references', 'paper_relations', 'paper_assets', 'custom_terms', 'writing_drafts'
        ) ORDER BY name
      `).all().map(({ name }) => name);
      assert.deepEqual(tables, [
        "custom_terms", "paper_assets", "paper_references", "paper_relations", "writing_drafts"
      ]);
      assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 8);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("knowledge parsers extract reference and figure/table captions", async () => {
  const { parsePaperAssets, parsePaperReferences } = await import("../src/knowledge.js");
  const pages = [
    { pageNumber: 8, text: "Fig. 2. Age-depth model for the loess section.\n表 1 样品与年代信息" },
    { pageNumber: 12, text: "References\nSmith, J. 2020. Lake sediment change. https://doi.org/10.1000/lake.2020\nBrown, P. (2019). Holocene climate history." }
  ];

  assert.deepEqual(parsePaperAssets(pages), [
    { pageNumber: 8, assetType: "figure", label: "Fig. 2", caption: "Age-depth model for the loess section." },
    { pageNumber: 8, assetType: "table", label: "表 1", caption: "样品与年代信息" }
  ]);
  const references = parsePaperReferences(pages);
  assert.equal(references.length, 2);
  assert.equal(references[0].doi, "10.1000/lake.2020");
  assert.equal(references[0].year, 2020);
  assert.equal(references[1].title, "Holocene climate history");
  assert.equal(references[1].pageNumber, 12);
});

test("repository rebuilds knowledge idempotently and links only active DOI matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-knowledge-repo-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const targetId = createPaper(repo, { title: "Lake sediment change", doi: "10.1000/lake.2020" });
    const sourceId = createPaper(repo, { title: "Source synthesis", regions: ["North"], methods: ["pollen"] });
    repo.replacePaperPages(sourceId, [
      { pageNumber: 1, text: "Fig. 1. Location of the study sites.", source: "pdf" },
      { pageNumber: 2, text: "References\nSmith, J. 2020. Lake sediment change. doi:10.1000/lake.2020", source: "pdf" }
    ]);

    assert.deepEqual(repo.rebuildPaperKnowledge(sourceId), { references: 1, assets: 1, citationRelations: 1 });
    assert.deepEqual(repo.rebuildPaperKnowledge(sourceId), { references: 1, assets: 1, citationRelations: 1 });
    assert.equal(repo.listPaperReferences(sourceId)[0].matchedPaperId, targetId);
    assert.equal(repo.listPaperAssets(sourceId)[0].pageNumber, 1);
    assert.deepEqual(repo.listPaperRelations(sourceId).stored.map((relation) => [relation.targetPaperId, relation.relationType]), [
      [targetId, "cites"]
    ]);

    repo.trashPaper(sourceId);
    assert.throws(() => repo.rebuildPaperKnowledge(sourceId), /active/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository stores and removes manual paper relations without affecting derived citations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-manual-relation-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const sourceId = createPaper(repo, { title: "Source" });
    const targetId = createPaper(repo, { title: "Target" });
    const relation = repo.upsertPaperRelation(sourceId, targetId, { relationType: "supports", reason: "Independent chronology agrees" });
    assert.equal(relation.origin, "manual");
    assert.equal(relation.targetTitle, "Target");
    assert.equal(repo.listPaperRelations(sourceId).stored[0].relationType, "supports");
    assert.equal(repo.deletePaperRelation(sourceId, relation.id), true);
    assert.equal(repo.listPaperRelations(sourceId).stored.length, 0);
    assert.throws(() => repo.upsertPaperRelation(sourceId, sourceId, { relationType: "related" }), /different/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
