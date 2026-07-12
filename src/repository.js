import { openDb } from "./database.js";
import { mergePaperData, metadataFields, noteFields } from "./paperData.js";
import { normalizeDoi, normalizeTitle, titleBigrams, titleSimilarity } from "./duplicates.js";
import { buildSearchQuery, matchesSearchGroups } from "./search.js";
import {
  normalizeTextSelector,
  validateAnnotationInput,
  validateResearchCardInput
} from "./annotations.js";

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
const arrayPaperFields = new Set(["authors", "keywords", "themes", "regions", "periods", "materials", "methods", "proxies"]);

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

function mapPaperPage(row) {
  if (!row) return null;
  return {
    id: row.id,
    paperId: row.paper_id,
    pageNumber: row.page_number,
    text: row.text,
    source: row.text_source,
    language: row.language,
    characterCount: row.character_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAnnotation(row) {
  if (!row) return null;
  let textSelector = {};
  try {
    textSelector = JSON.parse(row.text_selector_json || "{}");
  } catch {
    textSelector = {};
  }
  return {
    id: row.id,
    paperId: row.paper_id,
    pageNumber: row.page_number,
    kind: row.kind,
    quoteText: row.quote_text,
    translatedText: row.translated_text,
    comment: row.comment,
    color: row.color,
    textSelector,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapResearchCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    annotationId: row.annotation_id,
    paperId: row.paper_id,
    pageNumber: row.page_number,
    quoteText: row.quote_text,
    translatedText: row.translated_text,
    summary: row.summary,
    personalInterpretation: row.personal_interpretation,
    themes: parseJson(row.themes_json, []),
    evidenceType: row.evidence_type,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapBackup(row) {
  if (!row) return null;
  return {
    id: row.id,
    backupType: row.backup_type,
    storedPath: row.stored_path,
    directoryPath: row.stored_path,
    manifestSha256: row.manifest_sha256,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at
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
    this.status = 409;
  }
}

export class DraftNotFoundError extends Error {
  constructor() {
    super("Draft not found");
    this.name = "DraftNotFoundError";
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

export class SearchQueryError extends Error {
  constructor() {
    super("Search query is invalid");
    this.name = "SearchQueryError";
    this.status = 400;
  }
}

function summarizePages(pages) {
  const sources = { pdf: 0, ocr: 0, mixed: 0 };
  for (const page of pages) sources[page.source] += 1;
  return { pageCount: pages.length, sources };
}

function mergeDecisionSummary(target, source, merged) {
  const fields = [...metadataFields, ...noteFields, "bookmarkPage", "lastReadPage"];
  const decisions = {};
  for (const field of fields) {
    const targetValue = target[field];
    const sourceValue = source[field];
    const result = merged[field];
    const serialize = (value) => JSON.stringify(value ?? null);
    decisions[field] = {
      decision: serialize(result) === serialize(targetValue)
        ? "target"
        : serialize(result) === serialize(sourceValue) ? "source" : "merged",
      target: targetValue ?? null,
      source: sourceValue ?? null,
      result: result ?? null
    };
  }
  return decisions;
}

function numericId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError(`${label} must be a positive integer`);
  return id;
}

function requireBackupRecord(db, backupRecordId) {
  const id = numericId(
    backupRecordId && typeof backupRecordId === "object" ? backupRecordId.backupRecordId : backupRecordId,
    "backupRecordId"
  );
  if (!db.prepare("SELECT 1 FROM backup_records WHERE id = ?").get(id)) {
    throw new PaperStateError("A pre-merge backup record is required");
  }
  return id;
}

function updateMergedPaper(db, target, merged) {
  const assignments = [];
  const values = [];
  for (const field of editableFields) {
    assignments.push(`${paperColumns[field]} = ?`);
    values.push(Object.hasOwn(paperJsonFields, field) ? toJson(merged[field], []) : merged[field]);
  }
  assignments.push(
    "stored_filename = ?", "stored_path = ?", "file_sha256 = ?",
    "bookmark_page = ?", "last_read_page = ?",
    "normalized_doi = ?", "normalized_title = ?", "search_text = ?"
  );
  values.push(
    merged.storedFilename || "", merged.storedPath || "", merged.fileSha256 || "",
    merged.bookmarkPage, merged.lastReadPage,
    normalizeDoi(merged.doi), normalizeTitle(merged.title), makeSearchText(merged)
  );
  db.prepare(`
    UPDATE papers
    SET ${assignments.join(", ")}, version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...values, target.id);
}

const duplicateReasonOrder = ["sha256", "doi", "title"];
const maxTitlePostingSize = 512;

function activePaperRows(db) {
  return db.prepare(`
    SELECT * FROM papers
    WHERE deleted_at IS NULL AND merged_into_id IS NULL
    ORDER BY id ASC
  `).all();
}

function paperHashMap(db) {
  const hashes = new Map();
  for (const row of db.prepare(`
    SELECT paper_files.paper_id, paper_files.sha256
    FROM paper_files
    JOIN papers ON papers.id = paper_files.paper_id
    WHERE paper_files.status = 'active'
      AND paper_files.sha256 <> ''
      AND papers.deleted_at IS NULL
      AND papers.merged_into_id IS NULL
    ORDER BY paper_files.id ASC
  `).all()) {
    if (!hashes.has(row.paper_id)) hashes.set(row.paper_id, new Set());
    hashes.get(row.paper_id).add(row.sha256);
  }
  for (const row of activePaperRows(db)) {
    if (!hashes.has(row.id)) hashes.set(row.id, new Set());
    if (row.file_sha256) hashes.get(row.id).add(row.file_sha256);
  }
  return hashes;
}

function activePaperData(db) {
  const papers = activePaperRows(db);
  const files = db.prepare(`
    SELECT paper_id, sha256
    FROM paper_files
    JOIN papers ON papers.id = paper_files.paper_id
    WHERE paper_files.paper_id IS NOT NULL
      AND paper_files.status = 'active'
      AND paper_files.sha256 <> ''
      AND papers.deleted_at IS NULL
      AND papers.merged_into_id IS NULL
    ORDER BY paper_files.id ASC
  `).all();
  return { papers, files };
}

function compactCandidate(row, reason, score) {
  return {
    paperId: row.id,
    reason,
    score,
    title: row.title,
    year: row.year,
    doi: row.doi
  };
}

function findDuplicateCandidates(db, input = {}) {
  const sha256 = String(input.sha256 || "").trim();
  const doi = normalizeDoi(input.doi);
  const title = normalizeTitle(input.title);
  const year = input.year === null || input.year === undefined || input.year === ""
    ? null
    : Number(input.year);
  const hashes = paperHashMap(db);
  const candidates = [];

  for (const row of activePaperRows(db)) {
    if (input.excludePaperId !== undefined && Number(input.excludePaperId) === row.id) continue;
    const rowDoi = row.normalized_doi || normalizeDoi(row.doi);
    const rowTitle = row.normalized_title || normalizeTitle(row.title);
    let candidate = null;
    if (sha256 && hashes.get(row.id)?.has(sha256)) {
      candidate = compactCandidate(row, "sha256", 1);
    } else if (doi && rowDoi && doi === rowDoi) {
      candidate = compactCandidate(row, "doi", 1);
    } else if (title && rowTitle) {
      const score = titleSimilarity(title, rowTitle);
      const matchingYear = year === null || row.year === null || year === row.year;
      if (score >= 0.92 && matchingYear) candidate = compactCandidate(row, "title", score);
    }
    if (candidate) candidates.push(candidate);
  }

  return candidates.sort((left, right) =>
    duplicateReasonOrder.indexOf(left.reason) - duplicateReasonOrder.indexOf(right.reason) ||
    right.score - left.score ||
    left.paperId - right.paperId
  );
}

function duplicateGroups(db) {
  const { papers, files } = activePaperData(db);
  const papersById = new Map(papers.map((paper) => [paper.id, paper]));
  const hashes = new Map();
  const papersByHash = new Map();
  const titleGroups = new Map();
  const titleRepresentatives = new Map();
  const doiGroups = new Map();
  const normalizedDoiByPaper = new Map();
  for (const paper of papers) {
    const paperHashes = new Set(paper.file_sha256 ? [paper.file_sha256] : []);
    hashes.set(paper.id, paperHashes);
    if (paper.file_sha256) {
      if (!papersByHash.has(paper.file_sha256)) papersByHash.set(paper.file_sha256, new Set());
      papersByHash.get(paper.file_sha256).add(paper.id);
    }

    const normalizedTitle = paper.normalized_title || normalizeTitle(paper.title);
    if (normalizedTitle) {
      if (!titleGroups.has(normalizedTitle)) titleGroups.set(normalizedTitle, new Set());
      titleGroups.get(normalizedTitle).add(paper.id);
      const representativeId = titleRepresentatives.get(normalizedTitle);
      if (representativeId === undefined || paper.id < representativeId) {
        titleRepresentatives.set(normalizedTitle, paper.id);
      }
    }

    const doi = paper.normalized_doi || normalizeDoi(paper.doi);
    normalizedDoiByPaper.set(paper.id, doi);
    if (doi) {
      if (!doiGroups.has(doi)) doiGroups.set(doi, new Set());
      doiGroups.get(doi).add(paper.id);
    }
  }
  for (const file of files) {
    if (!hashes.has(file.paper_id)) hashes.set(file.paper_id, new Set());
    hashes.get(file.paper_id).add(file.sha256);
    if (!papersByHash.has(file.sha256)) papersByHash.set(file.sha256, new Set());
    papersByHash.get(file.sha256).add(file.paper_id);
  }

  const unionFind = new DeterministicUnionFind(papers.map((paper) => paper.id));
  for (const paperIds of papersByHash.values()) {
    const sortedIds = [...paperIds].sort((left, right) => left - right);
    for (let index = 1; index < sortedIds.length; index += 1) {
      unionFind.union(sortedIds[0], sortedIds[index]);
    }
  }

  for (const paperIds of doiGroups.values()) {
    const sortedIds = [...paperIds].sort((left, right) => left - right);
    for (let index = 1; index < sortedIds.length; index += 1) {
      unionFind.union(sortedIds[0], sortedIds[index]);
    }
  }

  const exactTitleGroups = [...titleGroups.entries()]
    .filter(([, paperIds]) => paperIds.size > 1)
    .map(([normalizedTitle, paperIds]) => {
      const sortedIds = [...paperIds].sort((left, right) => left - right);
      for (let index = 1; index < sortedIds.length; index += 1) {
        unionFind.union(sortedIds[0], sortedIds[index]);
      }
      return { normalizedTitle, paperIds: sortedIds };
    })
    .sort((left, right) => compareText(left.normalizedTitle, right.normalizedTitle));

  const doiOutput = [...doiGroups.entries()]
    .filter(([, paperIds]) => paperIds.size > 1)
    .map(([doi, paperIds]) => ({
      doi,
      paperIds: [...paperIds].sort((left, right) => left - right)
    }))
    .sort((left, right) => compareText(left.doi, right.doi));

  const titleIndex = new Map();
  for (const [normalizedTitle, representativeId] of titleRepresentatives) {
    const keys = titleBigrams(normalizedTitle);
    if (keys.size === 0) keys.add(`title:${normalizedTitle}`);
    for (const key of keys) {
      if (!titleIndex.has(key)) titleIndex.set(key, new Set());
      titleIndex.get(key).add(representativeId);
    }
  }
  const titlePairs = new Map();
  for (const candidateIds of titleIndex.values()) {
    // Common bigrams are poor evidence and would recreate a quadratic candidate set.
    if (candidateIds.size > maxTitlePostingSize) continue;
    const sortedIds = [...candidateIds].sort((left, right) => left - right);
    for (let leftIndex = 0; leftIndex < sortedIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sortedIds.length; rightIndex += 1) {
        const leftId = sortedIds[leftIndex];
        const rightId = sortedIds[rightIndex];
        titlePairs.set(pairKey(leftId, rightId), [leftId, rightId]);
      }
    }
  }
  const titleCandidates = [];
  for (const [key, [leftId, rightId]] of titlePairs) {
    if (sharesHash(hashes.get(leftId), hashes.get(rightId))) continue;
    const leftDoi = normalizedDoiByPaper.get(leftId);
    if (leftDoi && leftDoi === normalizedDoiByPaper.get(rightId)) continue;
    const left = papersById.get(leftId);
    const right = papersById.get(rightId);
    const score = titleSimilarity(left.title, right.title);
    const matchingYear = left.year === null || right.year === null || left.year === right.year;
    if (score < 0.92 || !matchingYear) continue;
    unionFind.union(leftId, rightId);
    titleCandidates.push({
      sourcePaperId: leftId,
      ...compactCandidate(right, "title", score)
    });
  }

  const groups = {
    sha256: [...papersByHash.entries()]
      .filter(([, paperIds]) => paperIds.size > 1)
      .map(([sha256, paperIds]) => ({
        sha256,
        paperIds: [...paperIds].sort((left, right) => left - right)
      }))
      .sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0),
    doi: doiOutput,
    title: [...exactTitleGroups, ...titleCandidates]
  };
  const sortCandidates = (left, right) =>
    unionFind.find(left.sourcePaperId) - unionFind.find(right.sourcePaperId) ||
    left.sourcePaperId - right.sourcePaperId ||
    left.paperId - right.paperId ||
    right.score - left.score;
  groups.doi.sort(sortCandidates);
  groups.title.sort(sortCandidates);
  return groups;
}

function pairKey(left, right) {
  return `${Math.min(left, right)}:${Math.max(left, right)}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sharesHash(left = new Set(), right = new Set()) {
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const hash of smaller) {
    if (larger.has(hash)) return true;
  }
  return false;
}

class DeterministicUnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    const parent = this.parent.get(id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) this.parent.set(rightRoot, leftRoot);
    else this.parent.set(leftRoot, rightRoot);
  }
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

function expectedVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("expectedVersion must be a positive integer");
  }
  return value;
}

function requireActiveIndexedPage(db, paperId, pageNumber) {
  const paper = db.prepare(
    "SELECT deleted_at, merged_into_id FROM papers WHERE id = ?"
  ).get(paperId);
  if (!paper) throw new PaperNotFoundError();
  if (paper.deleted_at !== null || paper.merged_into_id !== null) {
    throw new PaperStateError("Paper must be active before editing annotations");
  }
  const page = db.prepare(
    "SELECT * FROM paper_pages WHERE paper_id = ? AND page_number = ?"
  ).get(paperId, pageNumber);
  if (!page) throw new RangeError("Page is not indexed for this paper");
  return page;
}

function annotationSelector(input, quoteText, page) {
  const source = input || { quote: quoteText };
  if (source.quote !== undefined && source.quote !== quoteText) {
    throw new TypeError("textSelector.quote must match quoteText");
  }
  return normalizeTextSelector({ ...source, quote: quoteText, pageText: page.text });
}

const searchScopes = new Set(["all", "metadata", "fulltext", "notes"]);
const searchScopeOrder = { fulltext: 0, metadata: 1, notes: 2 };

function searchMetadataText(paper) {
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
    paper.proxies?.join(" ")
  ].filter(Boolean).join(" ");
}

function searchNotesText(paper) {
  return [
    paper.notesResearchQuestion,
    paper.notesRegion,
    paper.notesMaterialsMethods,
    paper.notesChronology,
    paper.notesCoreFindings,
    paper.notesLimits,
    paper.notesQuotePoints,
    paper.notesPersonal
  ].filter(Boolean).join(" ");
}

function filterPaper(paper, filters) {
  return Object.entries(filters || {}).every(([field, expectedValues]) => {
    const expected = Array.isArray(expectedValues) ? expectedValues.filter(Boolean) : [];
    if (expected.length === 0) return true;
    const actual = Array.isArray(paper[field]) ? paper[field] : [];
    return expected.every((value) => actual.includes(value));
  });
}

function truncateSearchText(value, maxLength = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
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
      db.exec("BEGIN IMMEDIATE");
      try {
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
        db.exec("COMMIT");
        return Number(result.lastInsertRowid);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  createBackupRecord(record) {
    return this.withDb((db) => {
      const values = [
        record.backupType,
        record.directoryPath ?? record.storedPath,
        record.manifestSha256 || "",
        Number(record.sizeBytes || 0),
        record.createdAt || new Date().toISOString()
      ];
      const result = Number.isSafeInteger(Number(record.id)) && Number(record.id) > 0
        ? db.prepare(`
          INSERT OR REPLACE INTO backup_records (id, backup_type, stored_path, manifest_sha256, size_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(Number(record.id), ...values)
        : db.prepare(`
          INSERT INTO backup_records (backup_type, stored_path, manifest_sha256, size_bytes, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(...values);
      return this.getBackupRecord(Number(result.lastInsertRowid));
    });
  }

  listBackupRecords() {
    return this.withDb((db) => db.prepare(`
      SELECT id, backup_type, stored_path, manifest_sha256, size_bytes, created_at
      FROM backup_records
      ORDER BY created_at DESC, id DESC
    `).all().map(mapBackup));
  }

  getBackupRecord(id) {
    return this.withDb((db) => mapBackup(db.prepare(`
      SELECT id, backup_type, stored_path, manifest_sha256, size_bytes, created_at
      FROM backup_records
      WHERE id = ?
    `).get(Number(id))));
  }

  deleteBackupRecord(id) {
    return this.withDb((db) => Number(db.prepare("DELETE FROM backup_records WHERE id = ?").run(Number(id)).changes) === 1);
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

  findDuplicatePapers(input = {}) {
    return this.withDb((db) => findDuplicateCandidates(db, input));
  }

  listDuplicateGroups() {
    return this.withDb((db) => duplicateGroups(db));
  }

  listActivePaperFilesMissingHashes() {
    return this.withDb((db) => db.prepare(`
      SELECT id, paper_id, stored_path
      FROM paper_files
      WHERE paper_id IS NOT NULL AND status = 'active' AND (sha256 IS NULL OR sha256 = '')
      ORDER BY id ASC
    `).all());
  }

  updatePaperFileHash(fileId, sha256) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const file = db.prepare(
          "SELECT id, paper_id FROM paper_files WHERE id = ? AND paper_id IS NOT NULL AND status = 'active'"
        ).get(fileId);
        if (!file) {
          db.exec("ROLLBACK");
          return false;
        }
        db.prepare("UPDATE paper_files SET sha256 = ? WHERE id = ?").run(sha256, file.id);
        db.prepare(`
          UPDATE papers
          SET file_sha256 = COALESCE((
            SELECT sha256 FROM paper_files
            WHERE paper_id = ? AND status = 'active' AND sha256 <> ''
            ORDER BY id ASC LIMIT 1
          ), '')
          WHERE id = ?
        `).run(file.paper_id, file.paper_id);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  deletePendingDraft(id) {
    return this.deletePendingDrafts([id]);
  }

  deletePendingDrafts(ids) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const draftIds = [...new Set(ids.map((id) => Number(id)))];
        if (draftIds.length === 0) throw new DraftNotFoundError();
        const placeholders = draftIds.map(() => "?").join(", ");
        const drafts = db.prepare(`SELECT * FROM drafts WHERE id IN (${placeholders})`).all(...draftIds);
        if (drafts.length !== draftIds.length) throw new DraftNotFoundError();
        if (drafts.some((draft) => draft.status !== "pending")) {
          throw new PaperStateError("Only pending drafts can be deleted");
        }

        const storedPaths = [
          ...drafts.map((draft) => draft.stored_path),
          ...db.prepare(
            `SELECT stored_path FROM paper_files WHERE draft_id IN (${placeholders}) AND stored_path <> ''`
          ).all(...draftIds).map((row) => row.stored_path)
        ].filter(Boolean);
        db.prepare(`DELETE FROM paper_files WHERE draft_id IN (${placeholders})`).run(...draftIds);
        db.prepare(`DELETE FROM drafts WHERE id IN (${placeholders}) AND status = 'pending'`).run(...draftIds);
        const protectedStoredPaths = [
          ...db.prepare("SELECT stored_path FROM papers WHERE stored_path <> ''").all().map((row) => row.stored_path),
          ...db.prepare("SELECT stored_path FROM paper_files WHERE stored_path <> ''").all().map((row) => row.stored_path)
        ];
        db.exec("COMMIT");
        return {
          storedPaths: [...new Set(storedPaths)],
          protectedStoredPaths: [...new Set(protectedStoredPaths)]
        };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  confirmDraft(id, overrides = {}) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const draft = mapDraft(db.prepare("SELECT * FROM drafts WHERE id = ?").get(id));
        if (!draft) throw new DraftNotFoundError();
        if (draft.status !== "pending") {
          throw new PaperStateError("Only pending drafts can be confirmed");
        }

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

        const statusUpdate = db.prepare(
          "UPDATE drafts SET status = 'confirmed' WHERE id = ? AND status = 'pending'"
        ).run(id);
        if (statusUpdate.changes !== 1) {
          throw new PaperStateError("Only pending drafts can be confirmed");
        }
        db.exec("COMMIT");
        return Number(result.lastInsertRowid);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  mergePapers(targetPaperId, sourcePaperId, backupRecordId) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const targetId = numericId(targetPaperId, "targetPaperId");
        const sourceId = numericId(sourcePaperId, "sourcePaperId");
        if (targetId === sourceId) throw new TypeError("A paper cannot be merged into itself");
        const targetRow = db.prepare("SELECT * FROM papers WHERE id = ?").get(targetId);
        const sourceRow = db.prepare("SELECT * FROM papers WHERE id = ?").get(sourceId);
        if (!targetRow || !sourceRow) throw new PaperNotFoundError();
        if (
          targetRow.deleted_at !== null || targetRow.merged_into_id !== null
          || sourceRow.deleted_at !== null || sourceRow.merged_into_id !== null
        ) {
          throw new PaperStateError("Both papers must be active before merging");
        }

        const backupId = requireBackupRecord(db, backupRecordId);
        const target = mapPaper(targetRow);
        const source = mapPaper(sourceRow);
        const merged = mergePaperData(target, source);
        updateMergedPaper(db, target, merged);
        db.prepare("UPDATE paper_files SET paper_id = ?, draft_id = NULL WHERE paper_id = ?").run(targetId, sourceId);
        db.prepare(`
          UPDATE papers
          SET deleted_at = CURRENT_TIMESTAMP, merged_into_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(targetId, sourceId);
        db.prepare(`
          INSERT INTO paper_merge_log (target_paper_id, source_paper_id, backup_record_id, summary_json)
          VALUES (?, ?, ?, ?)
        `).run(targetId, sourceId, backupId, JSON.stringify({ type: "paper", fields: mergeDecisionSummary(target, source, merged) }));

        const result = mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(targetId));
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  mergeDraft(draftId, targetPaperId, backupRecordId) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const sourceDraftId = numericId(draftId, "draftId");
        const targetId = numericId(targetPaperId, "targetPaperId");
        const draftRow = db.prepare("SELECT * FROM drafts WHERE id = ?").get(sourceDraftId);
        if (!draftRow) throw new DraftNotFoundError();
        if (draftRow.status !== "pending") throw new PaperStateError("Only pending drafts can be merged");
        const targetRow = db.prepare("SELECT * FROM papers WHERE id = ?").get(targetId);
        if (!targetRow) throw new PaperNotFoundError();
        if (targetRow.deleted_at !== null || targetRow.merged_into_id !== null) {
          throw new PaperStateError("Target paper must be active before merging");
        }

        const backupId = requireBackupRecord(db, backupRecordId);
        const target = mapPaper(targetRow);
        const draft = mapDraft(draftRow);
        const source = {
          storedFilename: draft.storedFilename,
          storedPath: draft.storedPath,
          fileSha256: draft.fileSha256,
          doi: draft.doi,
          title: draft.title,
          authors: draft.authors,
          journal: draft.journal,
          year: draft.year,
          abstract: draft.abstract,
          keywords: mergeUnique(draft.authorKeywords, draft.suggestedKeywords),
          themes: draft.classification.themes || [],
          regions: draft.classification.regions || [],
          periods: draft.classification.periods || [],
          materials: draft.classification.materials || [],
          methods: draft.classification.methods || [],
          proxies: draft.classification.proxies || [],
          readingStatus: "to-read",
          ...Object.fromEntries(noteFields.filter((field) => field !== "readingStatus").map((field) => [field, ""])),
          bookmarkPage: null,
          lastReadPage: null
        };
        const merged = mergePaperData(target, source);
        for (const field of arrayPaperFields) {
          if (Array.isArray(target[field]) && target[field].length > 0) merged[field] = target[field];
        }
        updateMergedPaper(db, target, merged);

        const draftFiles = db.prepare("SELECT id FROM paper_files WHERE draft_id = ? ORDER BY id ASC").all(sourceDraftId);
        if (draftFiles.length > 0) {
          const moveFile = db.prepare("UPDATE paper_files SET paper_id = ?, draft_id = NULL, status = 'active' WHERE id = ?");
          for (const draftFile of draftFiles) moveFile.run(targetId, draftFile.id);
        } else if (draft.storedPath) {
          db.prepare(`
            INSERT INTO paper_files (paper_id, stored_filename, stored_path, sha256)
            VALUES (?, ?, ?, ?)
          `).run(targetId, draft.storedFilename, draft.storedPath, draft.fileSha256);
        }
        db.prepare("UPDATE drafts SET status = 'merged' WHERE id = ? AND status = 'pending'").run(sourceDraftId);
        db.prepare(`
          INSERT INTO paper_merge_log (target_paper_id, source_paper_id, backup_record_id, summary_json)
          VALUES (?, ?, ?, ?)
        `).run(targetId, sourceDraftId, backupId, JSON.stringify({ type: "draft", fields: mergeDecisionSummary(target, source, merged) }));

        const result = mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(targetId));
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  getPaper(id) {
    return this.withDb((db) => mapPaper(db.prepare("SELECT * FROM papers WHERE id = ?").get(id)));
  }

  replacePaperPages(paperId, pages) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const id = numericId(paperId, "paperId");
        if (!Array.isArray(pages) || pages.length === 0) {
          throw new RangeError("Paper pages cannot be empty");
        }
        const paper = db.prepare("SELECT deleted_at, merged_into_id FROM papers WHERE id = ?").get(id);
        if (!paper) throw new PaperNotFoundError();
        if (paper.deleted_at !== null || paper.merged_into_id !== null) {
          throw new PaperStateError("Paper must be active before replacing pages");
        }

        const normalized = pages.map((page) => {
          const pageNumber = normalizePageNumber(page?.pageNumber);
          const source = String(page?.source || "");
          if (!["pdf", "ocr", "mixed"].includes(source)) {
            throw new TypeError("Page source must be pdf, ocr, or mixed");
          }
          const text = String(page?.text || "");
          const language = String(page?.language || "");
          return {
            pageNumber,
            text,
            source,
            language,
            characterCount: Array.from(text).length
          };
        });
        const numbers = normalized.map((page) => page.pageNumber).sort((left, right) => left - right);
        if (new Set(numbers).size !== numbers.length) throw new RangeError("Page numbers must be unique");
        if (numbers.some((pageNumber, index) => pageNumber !== index + 1)) {
          throw new RangeError("Page numbers must be continuous from 1");
        }

        db.prepare("DELETE FROM paper_pages WHERE paper_id = ?").run(id);
        const insert = db.prepare(`
          INSERT INTO paper_pages (paper_id, page_number, text, text_source, language, character_count)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const page of normalized) {
          insert.run(id, page.pageNumber, page.text, page.source, page.language, page.characterCount);
        }
        db.exec("COMMIT");
        return summarizePages(normalized);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  listPaperPages(paperId) {
    return this.withDb((db) => db.prepare(`
      SELECT id, paper_id, page_number, text, text_source, language, character_count, created_at, updated_at
      FROM paper_pages
      WHERE paper_id = ?
      ORDER BY page_number ASC
    `).all(Number(paperId)).map(mapPaperPage));
  }

  getPaperPage(paperId, pageNumber) {
    const normalizedPage = normalizePageNumber(pageNumber);
    return this.withDb((db) => mapPaperPage(db.prepare(`
      SELECT id, paper_id, page_number, text, text_source, language, character_count, created_at, updated_at
      FROM paper_pages
      WHERE paper_id = ? AND page_number = ?
    `).get(Number(paperId), normalizedPage)));
  }

  listAnnotations(paperId) {
    return this.withDb((db) => {
      const params = [];
      let where = "";
      if (paperId !== undefined && paperId !== null) {
        params.push(numericId(paperId, "paperId"));
        where = "WHERE paper_id = ?";
      }
      return db.prepare(`
        SELECT * FROM annotations
        ${where}
        ORDER BY page_number ASC, created_at ASC, id ASC
      `).all(...params).map(mapAnnotation);
    });
  }

  createAnnotation(input = {}) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const paperId = numericId(input.paperId, "paperId");
        const pageNumber = normalizePageNumber(input.pageNumber);
        const page = requireActiveIndexedPage(db, paperId, pageNumber);
        const fields = validateAnnotationInput(input);
        const selector = annotationSelector(input.textSelector, fields.quoteText, page);
        const result = db.prepare(`
          INSERT INTO annotations (
            paper_id, page_number, kind, quote_text, translated_text, comment, color,
            text_selector_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          paperId,
          pageNumber,
          fields.kind,
          fields.quoteText,
          fields.translatedText,
          fields.comment,
          fields.color,
          toJson(selector, {})
        );
        const annotation = mapAnnotation(db.prepare("SELECT * FROM annotations WHERE id = ?").get(Number(result.lastInsertRowid)));
        db.exec("COMMIT");
        return annotation;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateAnnotation(id, changes = {}) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const annotationId = numericId(id, "annotationId");
        const current = db.prepare("SELECT * FROM annotations WHERE id = ?").get(annotationId);
        if (!current) {
          db.exec("ROLLBACK");
          return null;
        }
        if (expectedVersion(changes.expectedVersion) !== current.version) {
          throw new VersionConflictError(changes.expectedVersion, current.version);
        }
        const paperId = changes.paperId === undefined ? current.paper_id : numericId(changes.paperId, "paperId");
        const pageNumber = changes.pageNumber === undefined ? current.page_number : normalizePageNumber(changes.pageNumber);
        const page = requireActiveIndexedPage(db, paperId, pageNumber);
        const fields = validateAnnotationInput({
          kind: changes.kind === undefined ? current.kind : changes.kind,
          color: changes.color === undefined ? current.color : changes.color,
          quoteText: changes.quoteText === undefined ? current.quote_text : changes.quoteText,
          translatedText: changes.translatedText === undefined ? current.translated_text : changes.translatedText,
          comment: changes.comment === undefined ? current.comment : changes.comment,
          textSelector: changes.textSelector === undefined ? JSON.parse(current.text_selector_json || "{}") : changes.textSelector
        });
        const selector = annotationSelector(changes.textSelector, fields.quoteText, page);
        db.prepare(`
          UPDATE annotations
          SET paper_id = ?, page_number = ?, kind = ?, quote_text = ?, translated_text = ?,
              comment = ?, color = ?, text_selector_json = ?, version = version + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND version = ?
        `).run(
          paperId,
          pageNumber,
          fields.kind,
          fields.quoteText,
          fields.translatedText,
          fields.comment,
          fields.color,
          toJson(selector, {}),
          annotationId,
          current.version
        );
        const updated = mapAnnotation(db.prepare("SELECT * FROM annotations WHERE id = ?").get(annotationId));
        db.exec("COMMIT");
        return updated;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  deleteAnnotation(id) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const annotationId = numericId(id, "annotationId");
        const annotation = db.prepare(
          "SELECT paper_id, page_number FROM annotations WHERE id = ?"
        ).get(annotationId);
        if (annotation) requireActiveIndexedPage(db, annotation.paper_id, annotation.page_number);
        db.prepare("UPDATE research_cards SET annotation_id = NULL WHERE annotation_id = ?").run(annotationId);
        const deleted = Number(db.prepare("DELETE FROM annotations WHERE id = ?").run(annotationId).changes) === 1;
        db.exec("COMMIT");
        return deleted;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  listResearchCards(paperId) {
    return this.withDb((db) => {
      const params = [];
      let where = "";
      if (paperId !== undefined && paperId !== null) {
        params.push(numericId(paperId, "paperId"));
        where = "WHERE paper_id = ?";
      }
      return db.prepare(`
        SELECT * FROM research_cards
        ${where}
        ORDER BY page_number ASC, created_at ASC, id ASC
      `).all(...params).map(mapResearchCard);
    });
  }

  createResearchCard(input = {}) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const paperId = numericId(input.paperId, "paperId");
        const pageNumber = normalizePageNumber(input.pageNumber);
        requireActiveIndexedPage(db, paperId, pageNumber);
        const fields = validateResearchCardInput(input);
        let annotationId = null;
        if (input.annotationId !== undefined && input.annotationId !== null) {
          annotationId = numericId(input.annotationId, "annotationId");
          const annotation = db.prepare(
            "SELECT paper_id, page_number FROM annotations WHERE id = ?"
          ).get(annotationId);
          if (!annotation || annotation.paper_id !== paperId || annotation.page_number !== pageNumber) {
            throw new TypeError("annotationId must reference the same paper page");
          }
        }
        const result = db.prepare(`
          INSERT INTO research_cards (
            annotation_id, paper_id, page_number, quote_text, translated_text, summary,
            personal_interpretation, themes_json, evidence_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          annotationId,
          paperId,
          pageNumber,
          fields.quoteText,
          fields.translatedText,
          fields.summary,
          fields.personalInterpretation,
          toJson(fields.themes, []),
          fields.evidenceType
        );
        const card = mapResearchCard(db.prepare("SELECT * FROM research_cards WHERE id = ?").get(Number(result.lastInsertRowid)));
        db.exec("COMMIT");
        return card;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateResearchCard(id, changes = {}) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const cardId = numericId(id, "researchCardId");
        const current = db.prepare("SELECT * FROM research_cards WHERE id = ?").get(cardId);
        if (!current) {
          db.exec("ROLLBACK");
          return null;
        }
        if (expectedVersion(changes.expectedVersion) !== current.version) {
          throw new VersionConflictError(changes.expectedVersion, current.version);
        }
        const paperId = changes.paperId === undefined ? current.paper_id : numericId(changes.paperId, "paperId");
        const pageNumber = changes.pageNumber === undefined ? current.page_number : normalizePageNumber(changes.pageNumber);
        requireActiveIndexedPage(db, paperId, pageNumber);
        const themes = changes.themes === undefined ? parseJson(current.themes_json, []) : changes.themes;
        const fields = validateResearchCardInput({
          quoteText: changes.quoteText === undefined ? current.quote_text : changes.quoteText,
          translatedText: changes.translatedText === undefined ? current.translated_text : changes.translatedText,
          summary: changes.summary === undefined ? current.summary : changes.summary,
          personalInterpretation: changes.personalInterpretation === undefined ? current.personal_interpretation : changes.personalInterpretation,
          themes,
          evidenceType: changes.evidenceType === undefined ? current.evidence_type : changes.evidenceType
        });
        let annotationId = current.annotation_id;
        if (changes.annotationId !== undefined) {
          annotationId = changes.annotationId === null ? null : numericId(changes.annotationId, "annotationId");
          if (annotationId !== null) {
            const annotation = db.prepare("SELECT paper_id, page_number FROM annotations WHERE id = ?").get(annotationId);
            if (!annotation || annotation.paper_id !== paperId || annotation.page_number !== pageNumber) {
              throw new TypeError("annotationId must reference the same paper page");
            }
          }
        }
        db.prepare(`
          UPDATE research_cards
          SET annotation_id = ?, paper_id = ?, page_number = ?, quote_text = ?, translated_text = ?,
              summary = ?, personal_interpretation = ?, themes_json = ?, evidence_type = ?,
              version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND version = ?
        `).run(
          annotationId,
          paperId,
          pageNumber,
          fields.quoteText,
          fields.translatedText,
          fields.summary,
          fields.personalInterpretation,
          toJson(fields.themes, []),
          fields.evidenceType,
          cardId,
          current.version
        );
        const updated = mapResearchCard(db.prepare("SELECT * FROM research_cards WHERE id = ?").get(cardId));
        db.exec("COMMIT");
        return updated;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  deleteResearchCard(id) {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const cardId = numericId(id, "researchCardId");
        const card = db.prepare(
          "SELECT paper_id, page_number FROM research_cards WHERE id = ?"
        ).get(cardId);
        if (card) requireActiveIndexedPage(db, card.paper_id, card.page_number);
        const deleted = Number(db.prepare("DELETE FROM research_cards WHERE id = ?").run(cardId).changes) === 1;
        db.exec("COMMIT");
        return deleted;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  getPaperIndexState(paperId) {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT text_source, COUNT(*) AS count
        FROM paper_pages
        WHERE paper_id = ?
        GROUP BY text_source
      `).all(Number(paperId));
      const sources = { pdf: 0, ocr: 0, mixed: 0 };
      for (const row of rows) sources[row.text_source] = row.count;
      return { pageCount: rows.reduce((total, row) => total + row.count, 0), sources };
    });
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
        if (current.deletedAt !== null || current.mergedIntoId !== null) {
          throw new PaperStateError("Paper must be active before editing");
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
      const existing = db.prepare("SELECT * FROM papers WHERE id = ?").get(id);
      if (!existing) return null;
      if (existing.deleted_at !== null || existing.merged_into_id !== null) {
        throw new PaperStateError("Paper must be active before updating reading progress");
      }

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
        if (current.merged_into_id !== null) {
          throw new PaperStateError("Merged paper cannot be purged");
        }
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

        const protectedStoredPaths = [
          ...db
            .prepare("SELECT stored_path FROM papers WHERE stored_path <> ''")
            .all()
            .map((row) => row.stored_path),
          ...db
            .prepare("SELECT stored_path FROM paper_files WHERE stored_path <> ''")
            .all()
            .map((row) => row.stored_path)
        ];

        db.exec("COMMIT");
        return {
          paper,
          storedPaths: [...new Set(storedPaths)],
          protectedStoredPaths: [...new Set(protectedStoredPaths)]
        };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  purgeAllTrashedPapers() {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = db
          .prepare("SELECT * FROM papers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC")
          .all();
        if (rows.some((row) => row.merged_into_id !== null)) {
          throw new PaperStateError("Merged paper cannot be purged");
        }

        const papers = rows.map(mapPaper);
        const storedPaths = [];
        for (const paper of papers) {
          storedPaths.push(
            ...db
              .prepare("SELECT stored_path FROM paper_files WHERE paper_id = ? AND stored_path <> ''")
              .all(paper.id)
              .map((row) => row.stored_path),
            paper.storedPath
          );
        }

        for (const paper of papers) {
          db.prepare("DELETE FROM paper_files WHERE paper_id = ? OR draft_id = ?").run(paper.id, paper.sourceDraftId);
        }
        db.prepare("DELETE FROM papers WHERE deleted_at IS NOT NULL AND merged_into_id IS NULL").run();

        const protectedStoredPaths = [
          ...db
            .prepare("SELECT stored_path FROM papers WHERE stored_path <> ''")
            .all()
            .map((row) => row.stored_path),
          ...db
            .prepare("SELECT stored_path FROM paper_files WHERE stored_path <> ''")
            .all()
            .map((row) => row.stored_path)
        ];

        db.exec("COMMIT");
        return {
          papers,
          storedPaths: [...new Set(storedPaths.filter(Boolean))],
          protectedStoredPaths: [...new Set(protectedStoredPaths)]
        };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  searchLibrary({ query = "", scope = "all", filters = {}, page = 1, pageSize = 20 } = {}) {
    if (!searchScopes.has(scope)) throw new SearchQueryError();
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new SearchQueryError();
    }

    const search = buildSearchQuery(query);
    if (!search) return { items: [], page, pageSize, total: 0 };

    return this.withDb((db) => {
      const papers = db.prepare(`
        SELECT * FROM papers
        WHERE deleted_at IS NULL AND merged_into_id IS NULL
        ORDER BY id ASC
      `).all().map(mapPaper).filter((paper) => filterPaper(paper, filters));
      const papersById = new Map(papers.map((paper) => [paper.id, paper]));
      const items = [];

      if (scope === "all" || scope === "metadata") {
        for (const paper of papers) {
          const text = searchMetadataText(paper);
          if (!matchesSearchGroups(text, search.groups)) continue;
          items.push({
            paperId: paper.id,
            title: paper.title,
            authors: paper.authors,
            year: paper.year,
            matchScope: "metadata",
            pageNumber: null,
            snippet: truncateSearchText(text),
            highlightTerms: search.highlightTerms,
            score: 0
          });
        }
      }

      if (scope === "all" || scope === "notes") {
        for (const paper of papers) {
          const text = searchNotesText(paper);
          if (!matchesSearchGroups(text, search.groups)) continue;
          items.push({
            paperId: paper.id,
            title: paper.title,
            authors: paper.authors,
            year: paper.year,
            matchScope: "notes",
            pageNumber: null,
            snippet: truncateSearchText(text),
            highlightTerms: search.highlightTerms,
            score: 0
          });
        }
      }

      if (scope === "all" || scope === "fulltext") {
        let rows;
        try {
          rows = db.prepare(`
            SELECT pp.paper_id, pp.page_number,
              snippet(paper_pages_fts, 0, '', '', '...', 24) AS snippet,
              bm25(paper_pages_fts) AS score
            FROM paper_pages_fts
            JOIN paper_pages AS pp ON pp.id = paper_pages_fts.rowid
            WHERE paper_pages_fts MATCH ?
            ORDER BY score ASC, pp.paper_id ASC, pp.page_number ASC
          `).all(search.match);
        } catch {
          throw new SearchQueryError();
        }
        for (const row of rows) {
          const paper = papersById.get(row.paper_id);
          if (!paper) continue;
          items.push({
            paperId: paper.id,
            title: paper.title,
            authors: paper.authors,
            year: paper.year,
            matchScope: "fulltext",
            pageNumber: row.page_number,
            snippet: String(row.snippet || ""),
            highlightTerms: search.highlightTerms,
            score: Number(row.score) || 0
          });
        }
      }

      items.sort((left, right) =>
        left.score - right.score ||
        searchScopeOrder[left.matchScope] - searchScopeOrder[right.matchScope] ||
        left.paperId - right.paperId ||
        (left.pageNumber || 0) - (right.pageNumber || 0)
      );
      const offset = (page - 1) * pageSize;
      return {
        items: items.slice(offset, offset + pageSize),
        page,
        pageSize,
        total: items.length
      };
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
