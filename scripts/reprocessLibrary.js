import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  detectDoi,
  inferTitleFromText,
  parseAbstract,
  parseAuthors,
  parseJournal,
  parseKeywords,
  parseYear
} from "../src/pdfExtract.js";
import { classifyText } from "../src/taxonomy.js";

const dbPath = process.argv[2] || path.join("library", "library.sqlite");

function toJson(value) {
  return JSON.stringify(value ?? []);
}

function unique(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

function searchText(paper) {
  return [
    paper.title,
    paper.authors.join(" "),
    paper.journal,
    paper.year,
    paper.doi,
    paper.abstract,
    paper.keywords.join(" "),
    paper.themes.join(" "),
    paper.regions.join(" "),
    paper.periods.join(" "),
    paper.materials.join(" "),
    paper.methods.join(" "),
    paper.proxies.join(" "),
    paper.notes_research_question,
    paper.notes_region,
    paper.notes_materials_methods,
    paper.notes_chronology,
    paper.notes_core_findings,
    paper.notes_limits,
    paper.notes_quote_points,
    paper.notes_personal
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function reprocess(text) {
  const doi = detectDoi(text);
  const title = inferTitleFromText(text);
  const authors = parseAuthors(text);
  const journal = parseJournal(text);
  const year = parseYear(text);
  const abstract = parseAbstract(text);
  const authorKeywords = parseKeywords(text);
  const result = classifyText({ title, abstract, keywords: authorKeywords, text });
  const suggestedKeywords = unique(
    result.classification.themes,
    result.classification.methods,
    result.classification.proxies
  );

  return {
    doi,
    title,
    authors,
    journal,
    year,
    abstract,
    authorKeywords,
    suggestedKeywords,
    classification: result.classification,
    confidence: result.confidence,
    evidence: result.evidence
  };
}

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const backupDir = path.join(path.dirname(dbPath), "backups");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const backupPath = path.join(backupDir, `library-${stamp}.sqlite`);
copyFileSync(dbPath, backupPath);

const db = new DatabaseSync(dbPath);
const drafts = db.prepare("SELECT * FROM drafts ORDER BY id").all();
let updatedDrafts = 0;
let updatedPapers = 0;

const updateDraft = db.prepare(`
  UPDATE drafts
  SET doi = ?, title = ?, authors_json = ?, journal = ?, year = ?, abstract = ?,
      author_keywords_json = ?, suggested_keywords_json = ?, classification_json = ?,
      confidence_json = ?, evidence_json = ?
  WHERE id = ?
`);

const updatePaper = db.prepare(`
  UPDATE papers
  SET doi = ?, title = ?, authors_json = ?, journal = ?, year = ?, abstract = ?,
      keywords_json = ?, themes_json = ?, regions_json = ?, periods_json = ?,
      materials_json = ?, methods_json = ?, proxies_json = ?, search_text = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE source_draft_id = ?
`);

for (const draft of drafts) {
  const next = reprocess(draft.extracted_text || "");
  updateDraft.run(
    next.doi,
    next.title,
    toJson(next.authors),
    next.journal,
    next.year,
    next.abstract,
    toJson(next.authorKeywords),
    toJson(next.suggestedKeywords),
    JSON.stringify(next.classification),
    JSON.stringify(next.confidence),
    JSON.stringify(next.evidence),
    draft.id
  );
  updatedDrafts += 1;

  if (draft.status === "confirmed") {
    const paper = db.prepare("SELECT * FROM papers WHERE source_draft_id = ?").get(draft.id);
    if (paper) {
      const keywords = unique(next.authorKeywords, next.suggestedKeywords);
      const paperForSearch = {
        ...paper,
        doi: next.doi,
        title: next.title,
        authors: next.authors,
        journal: next.journal,
        year: next.year,
        abstract: next.abstract,
        keywords,
        themes: next.classification.themes,
        regions: next.classification.regions,
        periods: next.classification.periods,
        materials: next.classification.materials,
        methods: next.classification.methods,
        proxies: next.classification.proxies
      };
      updatePaper.run(
        next.doi,
        next.title,
        toJson(next.authors),
        next.journal,
        next.year,
        next.abstract,
        toJson(keywords),
        toJson(next.classification.themes),
        toJson(next.classification.regions),
        toJson(next.classification.periods),
        toJson(next.classification.materials),
        toJson(next.classification.methods),
        toJson(next.classification.proxies),
        searchText(paperForSearch),
        draft.id
      );
      updatedPapers += 1;
    }
  }
}

db.close();
console.log(
  JSON.stringify(
    {
      backupPath,
      updatedDrafts,
      updatedPapers
    },
    null,
    2
  )
);
