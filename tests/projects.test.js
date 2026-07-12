import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildEvidenceRows,
  exportProjectEvidenceCsv,
  exportProjectEvidenceMarkdown,
  normalizeProjectInput,
  normalizeProjectPaperInput
} from "../src/projects.js";
import { initDb } from "../src/database.js";
import { PaperRepository } from "../src/repository.js";

function createPaper(repo, title, { deleted = false } = {}) {
  const id = repo.withDb((db) => Number(db.prepare(`
    INSERT INTO papers (
      title, authors_json, year, regions_json, periods_json, materials_json,
      methods_json, search_text, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    JSON.stringify(["Author"]),
    2024,
    JSON.stringify(["North"]),
    JSON.stringify(["Holocene"]),
    JSON.stringify(["core"]),
    JSON.stringify(["pollen"]),
    title.toLowerCase(),
    deleted ? new Date().toISOString() : null
  ).lastInsertRowid));
  return id;
}

test("project pure functions normalize, sort, and export plain text safely", () => {
  assert.deepEqual(normalizeProjectInput({ name: "  Monsoon  ", description: " notes ", status: "active" }), {
    name: "Monsoon",
    description: "notes",
    status: "active"
  });
  assert.throws(() => normalizeProjectInput({ name: "<script>" }), /plain text/);
  assert.deepEqual(normalizeProjectPaperInput({ priority: 4, stance: "supports", projectStatus: "reading", projectNote: "note" }), {
    priority: 4,
    stance: "supports",
    projectStatus: "reading",
    projectNote: "note"
  });
  assert.throws(() => normalizeProjectPaperInput({ priority: 6 }), /priority/);
  assert.throws(() => normalizeProjectPaperInput({ stance: "invalid" }), /stance/);

  const rows = buildEvidenceRows({
    projectPapers: [
      { projectId: 1, paperId: 2, priority: 2, stance: "supports", projectStatus: "reading", projectNote: "note, \"quoted\"" },
      { projectId: 1, paperId: 1, priority: 1, stance: "background", projectStatus: "queued", projectNote: "" }
    ],
    papers: [
      { id: 2, citationKey: "b-key", title: "B | title\nnext", authors: ["B"], year: 2020, regions: ["South"], periods: ["Pleistocene"], materials: ["shell"], methods: ["isotope"] },
      { id: 1, citationKey: "a-key", title: "A title", authors: ["A"], year: 2021, regions: ["North"], periods: ["Holocene"], materials: ["core"], methods: ["pollen"] }
    ],
    researchCards: [
      { id: 9, paperId: 2, pageNumber: 4, quoteText: "quote, \"one\"", summary: "summary", evidenceType: "supports" }
    ]
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].citationKey, "a-key");
  assert.equal(rows[1].card.quote, "quote, \"one\"");
  assert.equal(rows[1].classification.methods, "isotope");
  assert.match(exportProjectEvidenceCsv(rows), /"B \| title/);
  assert.match(exportProjectEvidenceCsv(rows), /"note, ""quoted"""/);
  assert.match(exportProjectEvidenceMarkdown(rows), /B \\| title/);
  assert.match(exportProjectEvidenceMarkdown(rows), /title<br>next/);
  assert.ok(exportProjectEvidenceMarkdown(rows).indexOf("a-key") < exportProjectEvidenceMarkdown(rows).indexOf("b-key"));
});

test("repository supports multiple projects, optimistic locking, inactive relations, and atomic batches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-projects-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const firstPaperId = createPaper(repo, "First paper");
    const secondPaperId = createPaper(repo, "Second paper");
    const inactivePaperId = createPaper(repo, "Inactive paper", { deleted: true });

    const first = repo.createProject({ name: "Project A", description: "A" });
    const second = repo.createProject({ name: "Project B" });
    assert.equal(repo.addProjectPapers(first.id, [firstPaperId, secondPaperId], { priority: 2 }).length, 2);
    assert.equal(repo.addProjectPapers(second.id, [firstPaperId]).length, 1);
    assert.throws(() => repo.addProjectPapers(first.id, [inactivePaperId]), /active/);
    assert.equal(repo.listProjectPapers(first.id).length, 2);
    assert.equal(repo.listProjectPapers(second.id)[0].paperId, firstPaperId);
    assert.throws(() => repo.addProjectPapers(first.id, [inactivePaperId, firstPaperId]), /active/);
    assert.equal(repo.listProjectPapers(first.id).length, 2);

    const updated = repo.updateProject(first.id, { name: "Project A2", expectedVersion: first.version });
    assert.equal(updated.version, 2);
    assert.throws(() => repo.updateProject(first.id, { name: "stale", expectedVersion: first.version }), /conflict/);
    assert.throws(() => repo.updateProject(first.id, { status: "bad", expectedVersion: updated.version }), /status/);

    repo.trashPaper(secondPaperId);
    assert.equal(repo.listProjectPapers(first.id)[1].paperStatus, "inactive");
    assert.throws(() => repo.updateProjectPaper(first.id, secondPaperId, { priority: 0 }), /priority/);
    assert.equal(repo.removeProjectPaper(first.id, secondPaperId), true);
    assert.equal(repo.listProjectPapers(first.id).length, 1);

    assert.equal(repo.archiveProject(first.id, { expectedVersion: updated.version }).status, "archived");
    assert.equal(repo.deleteProject(second.id, { expectedVersion: second.version }), true);
    assert.equal(repo.getPaper(firstPaperId).title, "First paper");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a project preserves its paper and research cards", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-project-delete-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const paperId = createPaper(repo, "Retained paper");
    const project = repo.createProject({ name: "Retained project" });
    repo.addProjectPaper(project.id, paperId);
    repo.withDb((db) => db.prepare(`
      INSERT INTO research_cards (paper_id, page_number, quote_text, summary, evidence_type)
      VALUES (?, 1, 'quote', 'summary', 'supports')
    `).run(paperId));
    assert.equal(repo.deleteProject(project.id, { expectedVersion: project.version }), true);
    assert.equal(repo.getPaper(paperId).title, "Retained paper");
    assert.equal(repo.listResearchCards(paperId).length, 1);
    assert.equal(repo.listProjectPapers(project.id), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
