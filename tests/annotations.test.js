import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initDb, openDb } from "../src/database.js";
import { normalizeTextSelector } from "../src/annotations.js";
import { PaperRepository, VersionConflictError } from "../src/repository.js";

async function withRepository(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-annotations-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const db = openDb(dbPath);
    const paperId = Number(db.prepare(
      "INSERT INTO papers (title, search_text) VALUES (?, ?)"
    ).run("Annotation paper", "annotation paper").lastInsertRowid);
    db.prepare(`
      INSERT INTO paper_pages (paper_id, page_number, text, text_source, character_count)
      VALUES (?, 1, ?, 'pdf', ?)
    `).run(paperId, "prefix quote suffix", "prefix quote suffix".length);
    db.close();
    await callback(new PaperRepository(dbPath), { dbPath, paperId });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("migration v4 creates page-linked annotation and research card tables", async () => {
  await withRepository(async (_repo, { dbPath }) => {
    const db = openDb(dbPath);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('annotations', 'research_cards')"
    ).all().map(({ name }) => name).sort();
    const annotationColumns = db.prepare("PRAGMA table_info(annotations)").all().map(({ name }) => name);
    const cardColumns = db.prepare("PRAGMA table_info(research_cards)").all().map(({ name }) => name);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_annotations_paper_page', 'idx_research_cards_paper_annotation')"
    ).all().map(({ name }) => name).sort();
    db.close();

    assert.deepEqual(versions.map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(tables, ["annotations", "research_cards"]);
    assert.deepEqual(annotationColumns, [
      "id", "paper_id", "page_number", "kind", "quote_text", "translated_text",
      "comment", "color", "text_selector_json", "version", "created_at", "updated_at"
    ]);
    assert.deepEqual(cardColumns, [
      "id", "annotation_id", "paper_id", "page_number", "quote_text", "translated_text",
      "summary", "personal_interpretation", "themes_json", "evidence_type", "version",
      "created_at", "updated_at"
    ]);
    assert.deepEqual(indexes, ["idx_annotations_paper_page", "idx_research_cards_paper_annotation"]);
  });
});

test("normalizeTextSelector validates bounded context and offset pairs", () => {
  assert.deepEqual(
    normalizeTextSelector({
      quote: "quote",
      prefix: "prefix",
      suffix: "suffix",
      start: 7,
      end: 12,
      positionVerified: true,
      pageText: "prefix quote suffix"
    }),
    {
      quote: "quote",
      prefix: "prefix",
      suffix: "suffix",
      start: 7,
      end: 12,
      positionVerified: true
    }
  );
  assert.throws(() => normalizeTextSelector({ quote: "" }), /quote/i);
  assert.throws(() => normalizeTextSelector({ quote: "x", prefix: "a".repeat(33) }), /prefix/i);
  assert.throws(() => normalizeTextSelector({ quote: "x", start: 0 }), /start.*end|pair/i);
  assert.throws(() => normalizeTextSelector({ quote: "x", start: 3, end: 3 }), /end/i);
  assert.throws(() => normalizeTextSelector({ quote: "x", start: -1, end: 1 }), /non-negative|positive/i);
});

test("normalizeTextSelector clears verification when indexed slice differs", () => {
  const selector = normalizeTextSelector({
    quote: "quote",
    prefix: "prefix",
    suffix: "suffix",
    start: 7,
    end: 12,
    positionVerified: true,
    pageText: "prefix other suffix"
  });
  assert.equal(selector.positionVerified, false);
  assert.equal(selector.quote, "quote");
});

test("repository enforces active indexed pages and supports annotation/card CRUD", async () => {
  await withRepository(async (repo, { paperId }) => {
    const annotation = repo.createAnnotation({
      paperId,
      pageNumber: 1,
      kind: "highlight",
      quoteText: "quote",
      translatedText: "译文",
      comment: "comment",
      color: "yellow",
      textSelector: { quote: "quote", start: 7, end: 12, positionVerified: true, pageText: "prefix quote suffix" }
    });
    assert.equal(annotation.paperId, paperId);
    assert.equal(annotation.pageNumber, 1);
    assert.equal(annotation.version, 1);
    assert.equal(repo.listAnnotations(paperId).length, 1);

    const card = repo.createResearchCard({
      annotationId: annotation.id,
      paperId,
      pageNumber: 1,
      quoteText: "quote",
      translatedText: "译文",
      summary: "summary",
      personalInterpretation: "interpretation",
      themes: ["theme"],
      evidenceType: "supports"
    });
    assert.equal(repo.listResearchCards(paperId)[0].annotationId, annotation.id);

    const updated = repo.updateAnnotation(annotation.id, {
      expectedVersion: 1,
      comment: "updated"
    });
    assert.equal(updated.comment, "updated");
    assert.equal(updated.version, 2);
    assert.throws(
      () => repo.updateAnnotation(annotation.id, { expectedVersion: 1, comment: "stale" }),
      VersionConflictError
    );

    assert.equal(repo.deleteAnnotation(annotation.id), true);
    assert.equal(repo.listAnnotations(paperId).length, 0);
    const retainedCard = repo.listResearchCards(paperId)[0];
    assert.equal(retainedCard.annotationId, null);
    assert.equal(retainedCard.quoteText, "quote");
    assert.equal(retainedCard.pageNumber, 1);
    assert.equal(repo.updateResearchCard(card.id, {
      expectedVersion: 1,
      summary: "updated summary"
    }).summary, "updated summary");
    assert.equal(repo.deleteResearchCard(card.id), true);
  });
});

test("repository rejects missing pages and inactive papers for annotations", async () => {
  await withRepository(async (repo, { dbPath, paperId }) => {
    assert.throws(() => repo.createAnnotation({
      paperId,
      pageNumber: 2,
      kind: "highlight",
      quoteText: "quote"
    }), /page/i);

    const db = openDb(dbPath);
    db.prepare("UPDATE papers SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(paperId);
    db.close();
    assert.throws(() => repo.createAnnotation({
      paperId,
      pageNumber: 1,
      kind: "highlight",
      quoteText: "quote"
    }), /active/i);
  });
});

test("repository requires an active indexed page when deleting annotations or cards", async () => {
  await withRepository(async (repo, { dbPath, paperId }) => {
    const annotation = repo.createAnnotation({
      paperId,
      pageNumber: 1,
      kind: "highlight",
      quoteText: "quote"
    });
    const card = repo.createResearchCard({
      annotationId: annotation.id,
      paperId,
      pageNumber: 1,
      quoteText: "quote",
      evidenceType: "uncertain"
    });
    const db = openDb(dbPath);
    db.prepare("UPDATE papers SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(paperId);
    db.close();
    assert.throws(() => repo.deleteAnnotation(annotation.id), /active/i);
    assert.throws(() => repo.deleteResearchCard(card.id), /active/i);
  });
});
