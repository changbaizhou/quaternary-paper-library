import { openDb } from "./database.js";

const draftJsonFields = {
  authors: "authors_json",
  authorKeywords: "author_keywords_json",
  suggestedKeywords: "suggested_keywords_json",
  classification: "classification_json",
  confidence: "confidence_json",
  evidence: "evidence_json"
};

const paperJsonFields = {
  authors: "authors_json",
  keywords: "keywords_json",
  themes: "themes_json",
  regions: "regions_json",
  periods: "periods_json",
  materials: "materials_json",
  methods: "methods_json",
  proxies: "proxies_json"
};

function toJson(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function mapDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    originalFilename: row.original_filename,
    storedFilename: row.stored_filename,
    storedPath: row.stored_path,
    doi: row.doi,
    title: row.title,
    authors: parseJson(row.authors_json, []),
    journal: row.journal,
    year: row.year,
    abstract: row.abstract,
    authorKeywords: parseJson(row.author_keywords_json, []),
    suggestedKeywords: parseJson(row.suggested_keywords_json, []),
    classification: parseJson(row.classification_json, {}),
    confidence: parseJson(row.confidence_json, {}),
    evidence: parseJson(row.evidence_json, {}),
    extractedText: row.extracted_text,
    createdAt: row.created_at
  };
}

function mapPaper(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceDraftId: row.source_draft_id,
    storedFilename: row.stored_filename,
    storedPath: row.stored_path,
    doi: row.doi,
    title: row.title,
    authors: parseJson(row.authors_json, []),
    journal: row.journal,
    year: row.year,
    abstract: row.abstract,
    keywords: parseJson(row.keywords_json, []),
    themes: parseJson(row.themes_json, []),
    regions: parseJson(row.regions_json, []),
    periods: parseJson(row.periods_json, []),
    materials: parseJson(row.materials_json, []),
    methods: parseJson(row.methods_json, []),
    proxies: parseJson(row.proxies_json, []),
    readingStatus: row.reading_status,
    notesResearchQuestion: row.notes_research_question,
    notesRegion: row.notes_region,
    notesMaterialsMethods: row.notes_materials_methods,
    notesChronology: row.notes_chronology,
    notesCoreFindings: row.notes_core_findings,
    notesLimits: row.notes_limits,
    notesQuotePoints: row.notes_quote_points,
    notesPersonal: row.notes_personal,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mergeUnique(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

function makeSearchText(paper) {
  return [
    paper.title,
    paper.authors?.join(" "),
    paper.journal,
    paper.year,
    paper.doi,
    paper.abstract,
    paper.keywords?.join(" "),
    paper.themes?.join(" "),
    paper.regions?.join(" "),
    paper.periods?.join(" "),
    paper.materials?.join(" "),
    paper.methods?.join(" "),
    paper.proxies?.join(" "),
    paper.notesResearchQuestion,
    paper.notesRegion,
    paper.notesMaterialsMethods,
    paper.notesChronology,
    paper.notesCoreFindings,
    paper.notesLimits,
    paper.notesQuotePoints,
    paper.notesPersonal
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export class PaperRepository {
  constructor(dbPath) {
    this.dbPath = dbPath;
  }

  withDb(callback) {
    const db = openDb(this.dbPath);
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }

  createDraft(input) {
    return this.withDb((db) => {
      const stmt = db.prepare(`
        INSERT INTO drafts (
          original_filename, stored_filename, stored_path, doi, title, authors_json,
          journal, year, abstract, author_keywords_json, suggested_keywords_json,
          classification_json, confidence_json, evidence_json, extracted_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        input.originalFilename || "",
        input.storedFilename || "",
        input.storedPath || "",
        input.doi || "",
        input.title || "",
        toJson(input.authors, []),
        input.journal || "",
        input.year || null,
        input.abstract || "",
        toJson(input.authorKeywords, []),
        toJson(input.suggestedKeywords, []),
        toJson(input.classification, {}),
        toJson(input.confidence, {}),
        toJson(input.evidence, {}),
        input.extractedText || ""
      );
      return Number(result.lastInsertRowid);
    });
  }

  listPendingDrafts() {
    return this.withDb((db) =>
      db
        .prepare("SELECT * FROM drafts WHERE status = 'pending' ORDER BY created_at DESC, id DESC")
        .all()
        .map(mapDraft)
    );
  }

  getDraft(id) {
    return this.withDb((db) => mapDraft(db.prepare("SELECT * FROM drafts WHERE id = ?").get(id)));
  }

  confirmDraft(id, overrides = {}) {
    return this.withDb((db) => {
      const draft = mapDraft(db.prepare("SELECT * FROM drafts WHERE id = ?").get(id));
      if (!draft) throw new Error(`Draft ${id} not found`);

      const classification = {
        themes: overrides.themes ?? draft.classification.themes ?? [],
        regions: overrides.regions ?? draft.classification.regions ?? [],
        periods: overrides.periods ?? draft.classification.periods ?? [],
        materials: overrides.materials ?? draft.classification.materials ?? [],
        methods: overrides.methods ?? draft.classification.methods ?? [],
        proxies: overrides.proxies ?? draft.classification.proxies ?? []
      };

      const paper = {
        sourceDraftId: draft.id,
        storedFilename: overrides.storedFilename ?? draft.storedFilename,
        storedPath: overrides.storedPath ?? draft.storedPath,
        doi: overrides.doi ?? draft.doi,
        title: overrides.title ?? draft.title,
        authors: overrides.authors ?? draft.authors,
        journal: overrides.journal ?? draft.journal,
        year: overrides.year ?? draft.year,
        abstract: overrides.abstract ?? draft.abstract,
        keywords: mergeUnique(
          overrides.keywords ?? [],
          draft.authorKeywords ?? [],
          draft.suggestedKeywords ?? []
        ),
        ...classification,
        readingStatus: overrides.readingStatus || "to-read",
        notesResearchQuestion: overrides.notesResearchQuestion || "",
        notesRegion: overrides.notesRegion || "",
        notesMaterialsMethods: overrides.notesMaterialsMethods || "",
        notesChronology: overrides.notesChronology || "",
        notesCoreFindings: overrides.notesCoreFindings || "",
        notesLimits: overrides.notesLimits || "",
        notesQuotePoints: overrides.notesQuotePoints || "",
        notesPersonal: overrides.notesPersonal || ""
      };
      const searchText = makeSearchText(paper);

      const result = db
        .prepare(`
          INSERT INTO papers (
            source_draft_id, stored_filename, stored_path, doi, title, authors_json,
            journal, year, abstract, keywords_json, themes_json, regions_json,
            periods_json, materials_json, methods_json, proxies_json, reading_status,
            notes_research_question, notes_region, notes_materials_methods,
            notes_chronology, notes_core_findings, notes_limits, notes_quote_points,
            notes_personal, search_text
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          paper.sourceDraftId,
          paper.storedFilename,
          paper.storedPath,
          paper.doi,
          paper.title,
          toJson(paper.authors, []),
          paper.journal,
          paper.year,
          paper.abstract,
          toJson(paper.keywords, []),
          toJson(paper.themes, []),
          toJson(paper.regions, []),
          toJson(paper.periods, []),
          toJson(paper.materials, []),
          toJson(paper.methods, []),
          toJson(paper.proxies, []),
          paper.readingStatus,
          paper.notesResearchQuestion,
          paper.notesRegion,
          paper.notesMaterialsMethods,
          paper.notesChronology,
          paper.notesCoreFindings,
          paper.notesLimits,
          paper.notesQuotePoints,
          paper.notesPersonal,
          searchText
        );

      db.prepare("UPDATE drafts SET status = 'confirmed' WHERE id = ?").run(id);
      return Number(result.lastInsertRowid);
    });
  }

  getPaper(id) {
    return this.withDb((db) => mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(id)));
  }

  searchPapers({ query = "", filters = {} } = {}) {
    return this.withDb((db) => {
      const rows = db.prepare("SELECT * FROM papers ORDER BY updated_at DESC, id DESC").all();
      const needle = String(query || "").trim().toLowerCase();

      return rows
        .map(mapPaper)
        .filter((paper) => {
          if (needle) {
            const text = makeSearchText(paper);
            if (!text.includes(needle)) return false;
          }
          for (const [field, expectedValues] of Object.entries(filters || {})) {
            const expected = Array.isArray(expectedValues) ? expectedValues.filter(Boolean) : [];
            if (expected.length === 0) continue;
            const actual = paper[field] || [];
            if (!expected.every((value) => actual.includes(value))) return false;
          }
          return true;
        });
    });
  }
}

