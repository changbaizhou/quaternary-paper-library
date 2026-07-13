import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initDb } from "../src/database.js";
import { PaperRepository } from "../src/repository.js";
import {
  buildEvidenceInsert,
  formatWritingBibliography,
  normalizeWritingDraftInput
} from "../src/writing.js";

test("writing helpers normalize drafts and format evidence citations", () => {
  assert.deepEqual(normalizeWritingDraftInput({
    title: "  黄河连接时间 ",
    body: "正文",
    citationStyle: "gbt7714",
    citedPaperIds: [2, 1, 2]
  }), {
    title: "黄河连接时间",
    body: "正文",
    citationStyle: "gbt7714",
    citedPaperIds: [2, 1]
  });
  assert.throws(() => normalizeWritingDraftInput({ citationStyle: "unknown" }), /citationStyle/);
  assert.throws(() => normalizeWritingDraftInput({ citedPaperIds: [0] }), /paper/);

  const paper = { title: "Yellow River", authors: ["Qu Chen"], year: 2022, journal: "GRL", publicationType: "article" };
  const inserted = buildEvidenceInsert({ paper, quote: "Evidence text", pageNumber: 4, citationStyle: "apa7" });
  assert.match(inserted, /> Evidence text/);
  assert.match(inserted, /p\. 4/);
  assert.match(inserted, /\(Chen, 2022\)/);
  assert.match(formatWritingBibliography([paper], "gbt7714"), /Yellow River/);
});

test("repository persists one versioned writing draft per project and inserts evidence atomically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-writing-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const paperId = repo.confirmDraft(repo.createDraft({
      title: "Yellow River evidence",
      authors: ["Qu Chen"],
      year: 2022,
      journal: "GRL",
      classification: {}
    }));
    const project = repo.createProject({ name: "River project" });
    repo.addProjectPaper(project.id, paperId);

    const initial = repo.getWritingDraft(project.id);
    assert.equal(initial.projectId, project.id);
    assert.equal(initial.version, 1);
    assert.deepEqual(initial.citedPaperIds, []);

    const updated = repo.updateWritingDraft(project.id, {
      title: "Draft title",
      body: "Opening",
      citationStyle: "apa7",
      citedPaperIds: [],
      expectedVersion: initial.version
    });
    assert.equal(updated.version, 2);
    assert.equal(repo.getWritingDraft(project.id).body, "Opening");
    assert.throws(() => repo.updateWritingDraft(project.id, { body: "stale", expectedVersion: 1 }), /conflict/);

    const inserted = repo.insertWritingEvidence(project.id, {
      paperId,
      quote: "Loess evidence supports the timing.",
      pageNumber: 4,
      expectedVersion: updated.version
    });
    assert.equal(inserted.version, 3);
    assert.deepEqual(inserted.citedPaperIds, [paperId]);
    assert.match(inserted.body, /Loess evidence/);
    assert.match(inserted.bibliography, /Yellow River evidence/);
    assert.equal(repo.withDb((db) => db.prepare("SELECT COUNT(*) AS count FROM writing_drafts WHERE project_id = ?").get(project.id).count), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
