import { openDb } from "./database.js";
import { metadataFields, normalizeDoi, normalizeTitle, noteFields } from "./paperData.js";

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

const paperColumns = {
  doi: "doi",
  title: "title",
  authors: "authors_json",
  journal: "journal",
  year: "year",
  abstract: "abstract",
  keywords: "keywords_json",
  themes: "themes_json",
  regions: "regions_json",
  periods: "periods_json",
  materials: "materials_json",
  methods: "methods_json",
  proxies: "proxies_json",
  readingStatus: "reading_status",
  notesResearchQuestion: "notes_research_question",
  notesRegion: "notes_region",
  notesMaterialsMethods: "notes_materials_methods",
  notesChronology: "notes_chronology",
  notesCoreFindings: "notes_core_findings",
  notesLimits: "notes_limits",
  notesQuotePoints: "notes_quote_points",
  notesPersonal: "notes_personal"
};

const editableFields = [...metadataFields, ...noteFields];

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
    fileSha256: row.file_sha256,
    duplicateCandidates: parseJson(row.duplicate_candidates_json, []),
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
    fileSha256: row.file_sha256,
    doi: row.doi,
    normalizedDoi: row.normalized_doi,
    title: row.title,
    normalizedTitle: row.normalized_title,
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
    bookmarkPage: row.bookmark_page,
    lastReadPage: row.last_read_page,
    version: row.version,
    deletedAt: row.deleted_at,
    mergedIntoId: row.merged_into_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class VersionConflictError extends Error {
  constructor(expectedVersion, actualVersion) {
    super(`Paper version conflict: expected ${expectedVersion}, found ${actualVersion}`);
    this.name = "VersionConflictError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class PaperNotFoundError extends Error {
  constructor() {
    super("Paper not found");
    this.name = "PaperNotFoundError";
  }
}

export class PaperStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "PaperStateError";
  }
}

function normalizePageNumber(value) {
  if (value === null) return null;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("Page number must be a positive integer");
  }
  return page;
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
          classification_json, confidence_json, evidence_json, file_sha256,
          duplicate_candidates_json, extracted_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.fileSha256 || "",
        toJson(input.duplicateCandidates, []),
        input.extractedText || ""
      );
      if (input.storedPath) {
        db.prepare(`
          INSERT INTO paper_files (draft_id, stored_filename, stored_path, sha256)
          VALUES (?, ?, ?, ?)
        `).run(Number(result.lastInsertRowid), input.storedFilename || "", input.storedPath, input.fileSha256 || "");
      }
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
        fileSha256: draft.fileSha256,
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
            source_draft_id, stored_filename, stored_path, file_sha256, doi, normalized_doi,
            title, normalized_title, authors_json,
            journal, year, abstract, keywords_json, themes_json, regions_json,
            periods_json, materials_json, methods_json, proxies_json, reading_status,
            notes_research_question, notes_region, notes_materials_methods,
            notes_chronology, notes_core_findings, notes_limits, notes_quote_points,
            notes_personal, search_text
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          paper.sourceDraftId,
          paper.storedFilename,
          paper.storedPath,
          paper.fileSha256,
          paper.doi,
          normalizeDoi(paper.doi),
          paper.title,
          normalizeTitle(paper.title),
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

      const fileRow = db.prepare("SELECT id FROM paper_files WHERE draft_id = ?").get(id);
      if (fileRow) {
        db.prepare(`
          UPDATE paper_files
          SET paper_id = ?, draft_id = NULL, stored_filename = ?, stored_path = ?, sha256 = ?, status = 'active'
          WHERE id = ?
        `).run(
          Number(result.lastInsertRowid),
          paper.storedFilename,
          paper.storedPath,
          paper.fileSha256,
          fileRow.id
        );
      } else if (paper.storedPath) {
        db.prepare(`
          INSERT INTO paper_files (paper_id, stored_filename, stored_path, sha256)
          VALUES (?, ?, ?, ?)
        `).run(Number(result.lastInsertRowid), paper.storedFilename, paper.storedPath, paper.fileSha256);
      }

      db.prepare("UPDATE drafts SET status = 'confirmed' WHERE id = ?").run(id);
      return Number(result.lastInsertRowid);
    });
  }

  getPaper(id) {
    return this.withDb((db) => mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(id)));
  }

  updatePaper(id, changes = {}) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(id));
        if (!current) {
          db.exec("ROLLBACK");
          return null;
        }
        if (changes.expectedVersion !== current.version) {
          throw new VersionConflictError(changes.expectedVersion, current.version);
        }
        if (!editableFields.some((field) => Object.hasOwn(changes, field))) {
          throw new TypeError("At least one editable paper field is required");
        }

        const paper = { ...current };
        for (const field of editableFields) {
          if (Object.hasOwn(changes, field)) paper[field] = changes[field];
        }
        if (!String(paper.title || "").trim()) {
          throw new TypeError("Title must not be empty");
        }

        const assignments = [];
        const values = [];
        for (const field of editableFields) {
          assignments.push(`${paperColumns[field]} = ?`);
          values.push(Object.hasOwn(paperJsonFields, field) ? toJson(paper[field], []) : paper[field]);
        }
        assignments.push("normalized_doi = ?", "normalized_title = ?", "search_text = ?");
        values.push(normalizeDoi(paper.doi), normalizeTitle(paper.title), makeSearchText(paper));

        const result = db.prepare(`
          UPDATE papers
          SET ${assignments.join(", ")}, version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND version = ?
        `).run(...values, id, current.version);
        if (Number(result.changes) !== 1) {
          const latest = db.prepare("SELECT version FROM papers WHERE id = ?").get(id);
          throw new VersionConflictError(current.version, latest?.version);
        }

        const updated = mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(id));
        db.exec("COMMIT");
        return updated;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateReadingProgress(id, progress = {}) {
    return this.withDb((db) => {
      const existing = db.prepare("SELECT id FROM papers WHERE id = ?").get(id);
      if (!existing) return null;

      const assignments = [];
      const values = [];
      if (Object.hasOwn(progress, "lastReadPage")) {
        assignments.push("last_read_page = ?");
        values.push(normalizePageNumber(progress.lastReadPage));
      }
      if (Object.hasOwn(progress, "bookmarkPage")) {
        assignments.push("bookmark_page = ?");
        values.push(normalizePageNumber(progress.bookmarkPage));
      }

      if (assignments.length > 0) {
        db.prepare(
          `UPDATE papers SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(...values, id);
      }

      return mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(id));
    });
  }

  trashPaper(id) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT * FROM papers WHERE id = ?").get(id);
        if (!current) throw new PaperNotFoundError();
        if (current.deleted_at !== null) {
          throw new PaperStateError("Paper is already in trash");
        }
        if (current.merged_into_id !== null) {
          throw new PaperStateError("Merged paper cannot be moved to trash");
        }

        db.prepare(`
          UPDATE papers
          SET deleted_at = CURRENT_TIMESTAMP, version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND deleted_at IS NULL AND merged_into_id IS NULL
        `).run(id);
        db.prepare("UPDATE paper_files SET status = 'trash' WHERE paper_id = ?").run(id);

        const trashed = mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(id));
        db.exec("COMMIT");
        return trashed;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  listTrashedPapers() {
    return this.withDb((db) =>
      db
        .prepare(`
          SELECT * FROM papers
          WHERE deleted_at IS NOT NULL AND merged_into_id IS NULL
          ORDER BY deleted_at DESC, id DESC
        `)
        .all()
        .map(mapPaper)
    );
  }

  restorePaper(id) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT * FROM papers WHERE id = ?").get(id);
        if (!current) throw new PaperNotFoundError();
        if (current.deleted_at === null) {
          throw new PaperStateError("Paper is not in trash");
        }
        if (current.merged_into_id !== null) {
          throw new PaperStateError("Merged paper cannot be restored");
        }

        db.prepare(`
          UPDATE papers
          SET deleted_at = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND deleted_at IS NOT NULL AND merged_into_id IS NULL
        `).run(id);
        db.prepare("UPDATE paper_files SET status = 'active' WHERE paper_id = ?").run(id);

        const restored = mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(id));
        db.exec("COMMIT");
        return restored;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  purgePaper(id) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT * FROM papers WHERE id = ?").get(id);
        if (!current) throw new PaperNotFoundError();
        if (current.deleted_at === null) {
          throw new PaperStateError("Paper must be in trash before purge");
        }

        const paper = mapPaper(current);
        const storedPaths = [
          ...db
            .prepare("SELECT stored_path FROM paper_files WHERE paper_id = ? AND stored_path <> ''")
            .all(id)
            .map((row) => row.stored_path),
          paper.storedPath
        ].filter(Boolean);

        db.prepare("DELETE FROM paper_files WHERE paper_id = ? OR draft_id = ?").run(id, paper.sourceDraftId);
        db.prepare("DELETE FROM papers WHERE id = ? AND deleted_at IS NOT NULL").run(id);

        const referencedPaths = new Set([
          ...db
            .prepare("SELECT stored_path FROM papers WHERE stored_path <> ''")
            .all()
            .map((row) => row.stored_path),
          ...db
            .prepare("SELECT stored_path FROM paper_files WHERE stored_path <> ''")
            .all()
            .map((row) => row.stored_path)
        ]);
        const safeStoredPaths = [...new Set(storedPaths)].filter((storedPath) => !referencedPaths.has(storedPath));

        db.exec("COMMIT");
        return { paper, storedPaths: safeStoredPaths };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  searchPapers({ query = "", filters = {} } = {}) {
    return this.withDb((db) => {
      const rows = db
        .prepare(`
          SELECT * FROM papers
          WHERE deleted_at IS NULL AND merged_into_id IS NULL
          ORDER BY updated_at DESC, id DESC
        `)
        .all();
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
