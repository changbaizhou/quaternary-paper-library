import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfig } from "./config.js";
import {
  BackupValidationError,
  createDatabaseBackup,
  createFullBackup,
  restoreBackup,
  validateBackup
} from "./backups.js";
import { initDb } from "./database.js";
import { exportBibtex, exportCslJson, exportCsv, exportMarkdown, exportRis } from "./exporters.js";
import { formatApa7, formatGbt7714, formatInTextCitation, validateCitationMetadata } from "./citations.js";
import { lookupDoiMetadata, lookupTitleMetadata } from "./metadata.js";
import { extractOcrPages as defaultExtractOcrPages, extractOcrText as defaultExtractOcrText } from "./ocr.js";
import { metadataFields, noteFields } from "./paperData.js";
import { fingerprintBuffer } from "./duplicates.js";
import { removeLibraryFiles, resolveLibraryPdf } from "./fileStorage.js";
import {
  detectDoi,
  decodePossiblyMojibakeFilename,
  extractPdfText as defaultExtractPdfText,
  inferAuthorsFromFilename,
  inferTitleFromText,
  inferTitleFromFilename,
  isPoorTextExtraction,
  parseAbstract,
  parseAuthors,
  parseJournal,
  parseKeywords,
  parseYear
} from "./pdfExtract.js";
import { extractPdfPages as defaultExtractPdfPages, indexPaperSource } from "./pageText.js";
import {
  PaperNotFoundError,
  PaperRepository,
  PaperStateError,
  DraftNotFoundError,
  VersionConflictError,
  SearchQueryError,
  CitationKeyError,
  CitationValidationError
} from "./repository.js";
import { classifyText } from "./taxonomy.js";
import { translateText, TranslationError } from "./translation.js";
import { exportProjectEvidenceCsv, exportProjectEvidenceMarkdown } from "./projects.js";

const upload = multer({ storage: multer.memoryStorage() });
const arrayPaperFields = new Set([
  "authors", "keywords", "themes", "regions", "periods", "materials", "methods", "proxies"
]);
const citationMetadataFields = ["volume", "issue", "pages", "publisher", "publicationType"];

function validateExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("expectedVersion must be a positive integer");
  }
}

function pickPaperChanges(body, allowedFields) {
  validateExpectedVersion(body.expectedVersion);
  const changes = { expectedVersion: body.expectedVersion };

  for (const field of allowedFields) {
    if (!Object.hasOwn(body, field)) continue;
    const value = body[field];
    if (arrayPaperFields.has(field)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new TypeError(`${field} must be an array of strings`);
      }
    } else if (field === "year") {
      if (value !== null && (!Number.isInteger(value) || value < 1)) {
        throw new TypeError("year must be a positive integer or null");
      }
    } else if (field === "publicationType") {
      if (!["article", "book", "chapter", "thesis", "report", "conference", "other"].includes(value)) {
        throw new TypeError("publicationType is invalid");
      }
    } else if (typeof value !== "string") {
      throw new TypeError(`${field} must be a string`);
    }
    if (field === "title" && !value.trim()) {
      throw new TypeError("title must not be empty");
    }
    changes[field] = value;
  }

  return changes;
}

function updatePaperResponse(repo, request, response, allowedFields) {
  try {
    const changes = pickPaperChanges(request.body || {}, allowedFields);
    const paper = repo.updatePaper(Number(request.params.id), changes);
    if (!paper) {
      response.status(404).json({ error: "Paper not found" });
      return;
    }
    response.json(publicPaper(paper));
  } catch (error) {
    if (error instanceof VersionConflictError) {
      response.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof PaperStateError) {
      response.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof TypeError) {
      response.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
}

function slugify(value) {
  return String(value || "paper")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "paper";
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/[;,\uFF0C\uFF1B|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeMetadata(local, remote) {
  return {
    doi: remote.doi || local.doi || "",
    title: remote.title || local.title || "",
    authors: remote.authors?.length ? remote.authors : local.authors || [],
    journal: remote.journal || local.journal || "",
    year: remote.year || local.year || null,
    abstract: remote.abstract || local.abstract || "",
    authorKeywords: remote.authorKeywords?.length ? remote.authorKeywords : local.authorKeywords || []
  };
}

function metadataFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(4500) });
}

async function extractUploadText(filePath, options = {}) {
  const extractPdfText = options.extractPdfText || defaultExtractPdfText;
  const extractOcrText = options.extractOcrText || defaultExtractOcrText;
  let text = "";

  try {
    text = await extractPdfText(filePath);
  } catch {
    text = "[PDF text extraction unavailable]";
  }

  if (!isPoorTextExtraction(text)) return text;

  try {
    const ocrResult = await extractOcrText(filePath, options.ocr || {});
    if (ocrResult?.text) {
      return [ocrResult.text, text].filter(Boolean).join("\n\n");
    }
  } catch {
    // OCR is a best-effort fallback. Keep the original PDF extraction result.
  }

  return text;
}

async function createDraftFromText({
  repo,
  text,
  filename,
  storedFilename = "",
  storedPath = "",
  fileSha256 = "",
  enableLookup = false
}) {
  const doi = detectDoi(text);
  const decodedFilename = decodePossiblyMojibakeFilename(filename);
  const parsedTitle = inferTitleFromText(text);
  const filenameTitle = inferTitleFromFilename(decodedFilename);
  const parsedAuthors = parseAuthors(text);
  const filenameAuthors = inferAuthorsFromFilename(decodedFilename);
  const poorText = isPoorTextExtraction(text);
  const local = {
    doi,
    title: parsedTitle || filenameTitle,
    authors: parsedAuthors.length ? parsedAuthors : filenameAuthors,
    journal: parseJournal(text),
    year: parseYear(text),
    abstract: parseAbstract(text) || (poorText ? "PDF 文本抽取结果过少，文件可能是扫描版，需要 OCR 才能自动识别作者、摘要等信息。" : ""),
    authorKeywords: parseKeywords(text)
  };
  const remote =
    enableLookup && doi
      ? await lookupDoiMetadata(doi, { fetchImpl: metadataFetch })
      : enableLookup
        ? await lookupTitleMetadata(local.title, { fetchImpl: metadataFetch })
        : {};
  const metadata = mergeMetadata(local, remote);
  const classificationResult = classifyText({
    title: metadata.title,
    abstract: metadata.abstract,
    keywords: metadata.authorKeywords,
    text
  });
  const duplicateCandidates = repo.findDuplicatePapers({
    sha256: fileSha256,
    doi: metadata.doi,
    title: metadata.title,
    year: metadata.year
  });

  const draftId = repo.createDraft({
    originalFilename: filename,
    storedFilename,
    storedPath,
    fileSha256,
    ...metadata,
    duplicateCandidates,
    suggestedKeywords: [
      ...classificationResult.classification.themes,
      ...classificationResult.classification.methods,
      ...classificationResult.classification.proxies
    ],
    classification: classificationResult.classification,
    confidence: classificationResult.confidence,
    evidence: classificationResult.evidence,
    extractedText: text
  });

  return repo.getDraft(draftId);
}

function parseFilters(query) {
  const filterFields = ["themes", "regions", "periods", "materials", "methods", "proxies"];
  const filters = {};
  for (const field of filterFields) {
    if (query[field]) filters[field] = normalizeList(query[field]);
  }
  return filters;
}

function parseSearchInteger(value, fallback, maximum, label) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value))) throw new SearchQueryError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new SearchQueryError();
  }
  return parsed;
}

function requirePurgeConfirmation(body) {
  if (body?.confirm !== true) {
    throw new TypeError("confirm must be true");
  }
}

function respondToPaperStateError(error, response, next) {
  if (error instanceof PaperNotFoundError) {
    response.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof PaperStateError) {
    response.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof DraftNotFoundError) {
    response.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof TypeError) {
    response.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof RangeError) {
    response.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof CitationKeyError || error instanceof CitationValidationError || error.status === 400) {
    response.status(400).json({ error: error.message, missingFields: error.missingFields || undefined });
    return;
  }
  next(error);
}

function publicDraft(draft) {
  return {
    id: draft.id,
    status: draft.status,
    originalFilename: draft.originalFilename,
    doi: draft.doi,
    title: draft.title,
    authors: draft.authors,
    journal: draft.journal,
    year: draft.year,
    abstract: draft.abstract,
    authorKeywords: draft.authorKeywords,
    suggestedKeywords: draft.suggestedKeywords,
    classification: draft.classification,
    confidence: draft.confidence,
    evidence: draft.evidence,
    duplicateCandidates: draft.duplicateCandidates,
    extractedText: draft.extractedText,
    createdAt: draft.createdAt
  };
}

function scanPathLabel(filesDir, resolvedPath, storedPath) {
  if (resolvedPath) return path.relative(filesDir, resolvedPath).split(path.sep).join("/");
  return path.basename(String(storedPath || "").replace(/[\\/]+$/, "")) || "rejected";
}

function emptyCleanup() {
  return { removed: [], rejected: [], missing: [], failed: [], failedCount: 0 };
}

function appendCleanup(total, current) {
  for (const key of ["removed", "rejected", "missing", "failed"]) {
    total[key].push(...current[key]);
  }
  total.failedCount += current.failedCount;
}

function publicPaper(paper) {
  return {
    id: paper.id,
    doi: paper.doi,
    title: paper.title,
    authors: paper.authors,
    journal: paper.journal,
    year: paper.year,
    abstract: paper.abstract,
    keywords: paper.keywords,
    themes: paper.themes,
    regions: paper.regions,
    periods: paper.periods,
    materials: paper.materials,
    methods: paper.methods,
    proxies: paper.proxies,
    readingStatus: paper.readingStatus,
    notesResearchQuestion: paper.notesResearchQuestion,
    notesRegion: paper.notesRegion,
    notesMaterialsMethods: paper.notesMaterialsMethods,
    notesChronology: paper.notesChronology,
    notesCoreFindings: paper.notesCoreFindings,
    notesLimits: paper.notesLimits,
    notesQuotePoints: paper.notesQuotePoints,
    notesPersonal: paper.notesPersonal,
    citationKey: paper.citationKey,
    citationStatus: paper.citationStatus,
    citationCheckedAt: paper.citationCheckedAt,
    citationMissingFields: validateCitationMetadata(paper).missingFields,
    volume: paper.volume,
    issue: paper.issue,
    pages: paper.pages,
    publisher: paper.publisher,
    publicationType: paper.publicationType,
    bookmarkPage: paper.bookmarkPage,
    lastReadPage: paper.lastReadPage,
    deletedAt: paper.deletedAt,
    mergedIntoId: paper.mergedIntoId,
    version: paper.version,
    status: paper.deletedAt ? "trash" : "active"
  };
}

const citationExportFormats = {
  bibtex: { contentType: "application/x-bibtex; charset=utf-8", filename: "citations.bib", render: (papers) => exportBibtex(papers) },
  ris: { contentType: "application/x-research-info-systems; charset=utf-8", filename: "citations.ris", render: (papers) => exportRis(papers) },
  "csl-json": { contentType: "application/json; charset=utf-8", filename: "citations.json", render: (papers) => exportCslJson(papers) },
  gbt7714: { contentType: "text/plain; charset=utf-8", filename: "citations-gbt7714.txt", render: (papers) => papers.map(formatGbt7714).join("\n\n") },
  apa7: { contentType: "text/plain; charset=utf-8", filename: "citations-apa7.txt", render: (papers) => papers.map(formatApa7).join("\n\n") },
  "in-text-apa": { contentType: "text/plain; charset=utf-8", filename: "citations-in-text-apa.txt", render: (papers) => papers.map((paper) => formatInTextCitation(paper, "apa")).join("\n") },
  "in-text-gbt": { contentType: "text/plain; charset=utf-8", filename: "citations-in-text-gbt.txt", render: (papers) => papers.map((paper) => formatInTextCitation(paper, "gbt")).join("\n") }
};

function citationExportPapers(repo, query) {
  if (!query.ids) throw Object.assign(new TypeError("ids is required"), { status: 400 });
  if (query.ids === "all") return repo.searchPapers();
  const rawIds = String(query.ids).split(",").map((value) => value.trim());
  if (!rawIds.length || rawIds.some((value) => !/^\d+$/.test(value))) {
    throw Object.assign(new TypeError("ids must be a comma-separated list of positive integers or all"), { status: 400 });
  }
  const ids = rawIds.map(Number);
  if (new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw Object.assign(new TypeError("ids must contain unique positive integers"), { status: 400 });
  }
  return ids.map((id) => {
    const paper = repo.getPaper(id);
    if (!paper) throw Object.assign(new Error("Paper not found"), { status: 404 });
    if (paper.deletedAt !== null || paper.mergedIntoId !== null) {
      throw Object.assign(new Error("Paper must be active before export"), { status: 400 });
    }
    return paper;
  });
}

function publicAnnotation(annotation) {
  return {
    id: annotation.id,
    paperId: annotation.paperId,
    pageNumber: annotation.pageNumber,
    kind: annotation.kind,
    quoteText: annotation.quoteText,
    translatedText: annotation.translatedText,
    comment: annotation.comment,
    color: annotation.color,
    textSelector: annotation.textSelector,
    version: annotation.version,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt
  };
}

function publicResearchCard(card) {
  return {
    id: card.id,
    annotationId: card.annotationId,
    paperId: card.paperId,
    pageNumber: card.pageNumber,
    quoteText: card.quoteText,
    translatedText: card.translatedText,
    summary: card.summary,
    personalInterpretation: card.personalInterpretation,
    themes: card.themes,
    evidenceType: card.evidenceType,
    version: card.version,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt
  };
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    version: project.version,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

function publicProjectPaper(projectPaper) {
  return {
    projectId: projectPaper.projectId,
    paperId: projectPaper.paperId,
    priority: projectPaper.priority,
    stance: projectPaper.stance,
    projectStatus: projectPaper.projectStatus,
    projectNote: projectPaper.projectNote,
    paperStatus: projectPaper.paperStatus,
    citationKey: projectPaper.citationKey,
    title: projectPaper.title,
    authors: projectPaper.authors,
    year: projectPaper.year,
    deletedAt: projectPaper.deletedAt,
    createdAt: projectPaper.createdAt,
    updatedAt: projectPaper.updatedAt
  };
}

function sendProjectError(error, response, next) {
  if (error.status === 400 || error.status === 404 || error.status === 409 || error instanceof TypeError) {
    response.status(error.status || 400).json({ error: error.message });
    return;
  }
  if (error instanceof PaperNotFoundError) {
    response.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof PaperStateError) {
    response.status(409).json({ error: error.message });
    return;
  }
  next(error);
}

export function createPaperIndexService({
  repo,
  filesDir,
  extractPdfPages = defaultExtractPdfPages,
  extractOcrPages = defaultExtractOcrPages,
  ocr = {}
}) {
  return async (paperId) => {
    const paper = repo.getPaper(Number(paperId));
    if (!paper) throw new PaperNotFoundError();
    if (paper.deletedAt !== null || paper.mergedIntoId !== null) {
      throw new PaperStateError("Paper must be active before indexing");
    }
    const pdfPath = resolveLibraryPdf(filesDir, paper.storedPath);
    if (!pdfPath || !existsSync(pdfPath)) {
      return { indexState: "no-source", pageCount: 0, sources: { pdf: 0, ocr: 0, mixed: 0 } };
    }

    try {
      const summary = await indexPaperSource({
        paperId: paper.id,
        pdfPath,
        repo,
        extractPdfPages,
        extractOcrPages,
        ocr
      });
      return { indexState: "indexed", ...summary };
    } catch {
      const error = new Error("Page text extraction failed");
      error.status = 422;
      error.code = "PAPER_INDEX_FAILED";
      throw error;
    }
  };
}

function publicTrashPaper(paper) {
  return {
    id: paper.id,
    title: paper.title,
    year: paper.year,
    deletedAt: paper.deletedAt,
    version: paper.version,
    status: paper.deletedAt ? "trash" : "active"
  };
}

function compensateUpload(repo, filesDir, draftIds, writtenPaths) {
  const storedPaths = [...writtenPaths];
  let protectedStoredPaths = [];
  try {
    if (draftIds.length > 0) {
      const deleted = repo.deletePendingDrafts(draftIds);
      storedPaths.push(...deleted.storedPaths);
      protectedStoredPaths = deleted.protectedStoredPaths;
    }
  } catch {
    // Preserve the original upload error; cleanup failures must not disclose internals.
  }
  try {
    removeLibraryFiles(filesDir, storedPaths, protectedStoredPaths);
  } catch {
    // File cleanup is best effort and must not replace the original error.
  }
}

function pathInside(root, candidate) {
  const lexicalRelative = path.relative(path.resolve(root), path.resolve(candidate));
  if (lexicalRelative !== "" && (lexicalRelative.startsWith(`..${path.sep}`) || lexicalRelative === ".." || path.isAbsolute(lexicalRelative))) {
    return false;
  }
  try {
    const relative = path.relative(realpathSync(root), realpathSync(candidate));
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function publicBackup(record) {
  return {
    id: record.id,
    backupType: record.backupType,
    createdAt: record.createdAt,
    sizeBytes: record.sizeBytes
  };
}

function createAndRecordBackup(repo, config, type, reason, now) {
  const backup = type === "full"
    ? createFullBackup({ dbPath: config.dbPath, filesDir: config.filesDir, backupsDir: config.backupsDir, reason, now })
    : createDatabaseBackup({ dbPath: config.dbPath, backupsDir: config.backupsDir, reason, now });
  return repo.createBackupRecord(backup);
}

function pruneAutomaticBackups(repo, backupsDir) {
  const automatic = repo
    .listBackupRecords()
    .filter((record) => record.backupType === "automatic")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id);
  for (const record of automatic.slice(30)) {
    if (pathInside(backupsDir, record.storedPath)) {
      rmSync(record.storedPath, { recursive: true, force: true });
      repo.deleteBackupRecord(record.id);
    }
  }
}

function scheduleAutomaticBackup(repo, config, now) {
  const nowDate = new Date(typeof now === "function" ? now() : now);
  const newest = repo
    .listBackupRecords()
    .filter((record) => record.backupType === "automatic")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id)[0];
  const newestTime = newest ? Date.parse(newest.createdAt) : NaN;
  if (!newest || Number.isNaN(newestTime) || nowDate.getTime() - newestTime >= 24 * 60 * 60 * 1000) {
    const backup = createDatabaseBackup({
      dbPath: config.dbPath,
      backupsDir: config.backupsDir,
      reason: "automatic",
      now
    });
    repo.createBackupRecord({ ...backup, backupType: "automatic" });
  }
  pruneAutomaticBackups(repo, config.backupsDir);
}

export function createApp(options = {}) {
  const configured = { ...defaultConfig, ...options };
  const config = {
    ...configured,
    backupsDir: options.backupsDir ?? path.join(path.dirname(configured.dbPath), "backups")
  };
  const enableUploadLookup = config.enableUploadLookup ?? true;
  const now = config.now || (() => Date.now());
  mkdirSync(config.filesDir, { recursive: true });
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  mkdirSync(config.backupsDir, { recursive: true });
  initDb(config.dbPath, { backupsDir: config.backupsDir });
  const repo = new PaperRepository(config.dbPath);
  const indexPaper = createPaperIndexService({
    repo,
    filesDir: config.filesDir,
    extractPdfPages: config.extractPdfPages,
    extractOcrPages: config.extractOcrPages,
    ocr: config.ocr
  });
  if (config.automaticBackupsEnabled ?? true) scheduleAutomaticBackup(repo, config, now);
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use("/vendor/pdfjs-dist", express.static(path.join(process.cwd(), "node_modules", "pdfjs-dist")));
  app.use(express.static(config.staticDir));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/projects", (request, response, next) => {
    try {
      response.json(repo.listProjects(request.query.status));
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.post("/api/projects", (request, response, next) => {
    try {
      response.status(201).json(publicProject(repo.createProject(request.body || {})));
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.get("/api/projects/:id", (request, response, next) => {
    try {
      const project = repo.getProject(request.params.id);
      if (!project) {
        response.status(404).json({ error: "Project not found" });
        return;
      }
      response.json(publicProject(project));
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.patch("/api/projects/:id", (request, response, next) => {
    try {
      const project = repo.updateProject(request.params.id, request.body || {});
      if (!project) {
        response.status(404).json({ error: "Project not found" });
        return;
      }
      response.json(publicProject(project));
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.delete("/api/projects/:id", (request, response, next) => {
    try {
      if (request.body?.confirm !== true) {
        response.status(400).json({ error: "Project deletion confirmation is required" });
        return;
      }
      const deleted = repo.deleteProject(request.params.id, { expectedVersion: request.body.expectedVersion });
      if (!deleted) {
        response.status(404).json({ error: "Project not found" });
        return;
      }
      response.json({ deleted: true });
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.get("/api/projects/:id/papers", (request, response, next) => {
    try {
      const papers = repo.listProjectPapers(request.params.id);
      if (papers === null) {
        response.status(404).json({ error: "Project not found" });
        return;
      }
      response.json(papers.map(publicProjectPaper));
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.post("/api/projects/:id/papers", (request, response, next) => {
    try {
      const body = request.body || {};
      const { paperIds, ...defaults } = body;
      response.status(201).json(repo.addProjectPapers(request.params.id, paperIds, defaults).map(publicProjectPaper));
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.patch("/api/projects/:id/papers/:paperId", (request, response, next) => {
    try {
      const relation = repo.updateProjectPaper(request.params.id, request.params.paperId, request.body || {});
      if (!relation) {
        response.status(404).json({ error: "Project paper relation not found" });
        return;
      }
      response.json(publicProjectPaper(relation));
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.delete("/api/projects/:id/papers/:paperId", (request, response, next) => {
    try {
      if (request.body?.confirm !== true) {
        response.status(400).json({ error: "Project paper removal confirmation is required" });
        return;
      }
      const removed = repo.removeProjectPaper(request.params.id, request.params.paperId);
      if (!removed) {
        response.status(404).json({ error: "Project paper relation not found" });
        return;
      }
      response.json({ removed: true });
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.get("/api/projects/:id/evidence", (request, response, next) => {
    try {
      const format = request.query.format || "json";
      const rows = repo.getProjectEvidence(request.params.id);
      if (rows === null) {
        response.status(404).json({ error: "Project not found" });
        return;
      }
      if (format === "json") {
        response.json(rows);
        return;
      }
      if (format === "csv") {
        response.type("text/csv").set("Content-Disposition", "attachment; filename=\"project-evidence.csv\"").send(exportProjectEvidenceCsv(rows));
        return;
      }
      if (format === "markdown") {
        response.type("text/markdown").set("Content-Disposition", "attachment; filename=\"project-evidence.md\"").send(exportProjectEvidenceMarkdown(rows));
        return;
      }
      response.status(400).json({ error: "Unsupported project evidence format" });
    } catch (error) {
      sendProjectError(error, response, next);
    }
  });

  app.get("/api/backups", (_request, response) => {
    response.json(repo.listBackupRecords().map(publicBackup));
  });

  app.post("/api/backups", (request, response, next) => {
    try {
      const type = request.body?.type;
      if (type !== "database" && type !== "full") {
        response.status(400).json({ error: "Backup type must be database or full" });
        return;
      }
      response.status(201).json(publicBackup(createAndRecordBackup(repo, config, type, "manual", now)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/backups/:id/restore", (request, response, next) => {
    try {
      if (request.body?.confirm !== true) {
        response.status(400).json({ error: "Restore confirmation is required" });
        return;
      }
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        response.status(404).json({ error: "Backup not found" });
        return;
      }
      const record = repo.getBackupRecord(id);
      if (!record) {
        response.status(404).json({ error: "Backup not found" });
        return;
      }
      if (!pathInside(config.backupsDir, record.storedPath)) {
        response.status(400).json({ error: "Invalid backup path" });
        return;
      }
      const validation = validateBackup(path.join(record.storedPath, "manifest.json"));
      if (!validation.valid) {
        response.status(400).json({ error: "Invalid backup manifest" });
        return;
      }
      const restored = restoreBackup({
        dbPath: config.dbPath,
        filesDir: config.filesDir,
        backupsDir: config.backupsDir,
        backupDirectory: record.storedPath,
        now
      });
      if (restored?.directoryPath) {
        repo.createBackupRecord(record);
        repo.createBackupRecord(restored);
      }
      response.json({ restored: true, backupId: id });
    } catch (error) {
      if (error instanceof BackupValidationError) {
        response.status(400).json({ error: "Invalid backup manifest" });
        return;
      }
      next(error);
    }
  });

  app.post("/api/drafts/from-text", async (request, response, next) => {
    try {
      const draft = await createDraftFromText({
        repo,
        text: request.body.text || "",
        filename: request.body.filename || "text-import.txt",
        enableLookup: Boolean(request.body.enableLookup)
      });
      response.status(201).json(publicDraft(draft));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/uploads", upload.array("files"), async (request, response, next) => {
    const writtenPaths = [];
    const draftIds = [];
    try {
      const drafts = [];
      const year = new Date().getFullYear();
      const targetDir = path.join(config.filesDir, String(year));
      mkdirSync(targetDir, { recursive: true });

      for (const file of request.files || []) {
        const fileSha256 = fingerprintBuffer(file.buffer);
        const decodedOriginalName = decodePossiblyMojibakeFilename(file.originalname);
        const extension = path.extname(decodedOriginalName) || ".pdf";
        const storedFilename = `${now()}-${randomUUID()}-${slugify(path.basename(decodedOriginalName, extension))}${extension}`;
        const targetPath = path.join(targetDir, storedFilename);
        writeFileSync(targetPath, file.buffer);
        writtenPaths.push(targetPath);

        const text = await extractUploadText(targetPath, {
          extractPdfText: config.extractPdfText,
          extractOcrText: config.extractOcrText,
          ocr: config.ocr
        });

        const draft = await createDraftFromText({
          repo,
          text,
          filename: decodedOriginalName,
          storedFilename,
          storedPath: path.relative(process.cwd(), targetPath),
          fileSha256,
          enableLookup: enableUploadLookup
        });
        draftIds.push(draft.id);
        drafts.push(draft);
      }

      response.status(201).json(drafts.map(publicDraft));
    } catch (error) {
      compensateUpload(repo, config.filesDir, draftIds, writtenPaths);
      next(error);
    }
  });

  app.get("/api/drafts", (_request, response) => {
    response.json(repo.listPendingDrafts().map(publicDraft));
  });

  app.delete("/api/drafts/:id", (request, response, next) => {
    try {
      requirePurgeConfirmation(request.body || {});
      const deleted = repo.deletePendingDraft(Number(request.params.id));
      const cleanup = removeLibraryFiles(
        config.filesDir,
        deleted.storedPaths,
        deleted.protectedStoredPaths
      );
      response.json({ cleanup });
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.post("/api/drafts/:id/confirm", async (request, response, next) => {
    try {
      const paperId = repo.confirmDraft(Number(request.params.id), request.body || {});
      let indexResult;
      try {
        indexResult = await indexPaper(paperId);
      } catch {
        indexResult = { indexState: "failed", error: "indexing failed" };
      }
      response.status(201).json({ ...publicPaper(repo.getPaper(paperId)), ...indexResult });
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.post("/api/papers/:id/reindex", async (request, response, next) => {
    try {
      if (request.body?.confirm !== true) {
        response.status(400).json({ error: "Reindex confirmation is required" });
        return;
      }
      const result = await indexPaper(Number(request.params.id));
      if (result.indexState === "no-source") {
        response.status(404).json({ error: "Source PDF not found", ...result });
        return;
      }
      response.status(200).json(result);
    } catch (error) {
      if (error instanceof PaperNotFoundError) {
        response.status(404).json({ error: "Paper not found" });
        return;
      }
      if (error instanceof PaperStateError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error.code === "PAPER_INDEX_FAILED") {
        response.status(422).json({ error: error.message, indexState: "failed" });
        return;
      }
      next(error);
    }
  });

  app.post("/api/papers/:id/merge", (request, response, next) => {
    try {
      if (request.body?.confirm !== true) {
        response.status(400).json({ error: "Merge confirmation is required" });
        return;
      }
      const targetId = Number(request.params.id);
      const sourceId = Number(request.body?.sourcePaperId);
      if (!Number.isSafeInteger(targetId) || targetId < 1 || !Number.isSafeInteger(sourceId) || sourceId < 1) {
        response.status(404).json({ error: "Paper not found" });
        return;
      }
      if (targetId === sourceId) {
        response.status(400).json({ error: "A paper cannot be merged into itself" });
        return;
      }
      const target = repo.getPaper(targetId);
      const source = repo.getPaper(sourceId);
      if (!target || !source) {
        response.status(404).json({ error: "Paper not found" });
        return;
      }
      if (target.deletedAt !== null || target.mergedIntoId !== null || source.deletedAt !== null || source.mergedIntoId !== null) {
        response.status(409).json({ error: "Both papers must be active before merging" });
        return;
      }
      const backup = createAndRecordBackup(repo, config, "database", "paper-merge", now);
      response.json(publicPaper(repo.mergePapers(targetId, sourceId, backup.id)));
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.post("/api/drafts/:id/merge", (request, response, next) => {
    try {
      if (request.body?.confirm !== true) {
        response.status(400).json({ error: "Merge confirmation is required" });
        return;
      }
      const draftId = Number(request.params.id);
      const targetId = Number(request.body?.targetPaperId);
      if (!Number.isSafeInteger(draftId) || draftId < 1 || !Number.isSafeInteger(targetId) || targetId < 1) {
        response.status(404).json({ error: "Draft or target paper not found" });
        return;
      }
      const draft = repo.getDraft(draftId);
      const target = repo.getPaper(targetId);
      if (!draft || !target) {
        response.status(404).json({ error: "Draft or target paper not found" });
        return;
      }
      if (draft.status !== "pending" || target.deletedAt !== null || target.mergedIntoId !== null) {
        response.status(409).json({ error: "Draft must be pending and target paper must be active" });
        return;
      }
      const backup = createAndRecordBackup(repo, config, "database", "draft-merge", now);
      response.json(publicPaper(repo.mergeDraft(draftId, targetId, backup.id)));
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.get("/api/papers", (request, response) => {
    response.json(repo.searchPapers({
        query: request.query.query || "",
        filters: parseFilters(request.query)
      }).map(publicPaper));
  });

  app.get("/api/search", (request, response) => {
    try {
      response.json(repo.searchLibrary({
        query: request.query.q || "",
        scope: request.query.scope === undefined ? "all" : request.query.scope,
        filters: parseFilters(request.query),
        page: parseSearchInteger(request.query.page, 1, Number.MAX_SAFE_INTEGER, "page"),
        pageSize: parseSearchInteger(request.query.pageSize, 20, 100, "pageSize")
      }));
    } catch (error) {
      if (error instanceof SearchQueryError) {
        response.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.get("/api/papers/:id/annotations", (request, response, next) => {
    try {
      const paperId = Number(request.params.id);
      if (!repo.getPaper(paperId)) {
        response.status(404).json({ error: "Paper not found" });
        return;
      }
      response.json(repo.listAnnotations(paperId).map(publicAnnotation));
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.post("/api/papers/:id/annotations", (request, response, next) => {
    try {
      const annotation = repo.createAnnotation({
        ...(request.body || {}),
        paperId: Number(request.params.id)
      });
      response.status(201).json(publicAnnotation(annotation));
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.patch("/api/annotations/:id", (request, response, next) => {
    try {
      const annotation = repo.updateAnnotation(Number(request.params.id), request.body || {});
      if (!annotation) {
        response.status(404).json({ error: "Annotation not found" });
        return;
      }
      response.json(publicAnnotation(annotation));
    } catch (error) {
      if (error instanceof VersionConflictError) {
        response.status(409).json({ error: error.message });
        return;
      }
      respondToPaperStateError(error, response, next);
    }
  });

  app.delete("/api/annotations/:id", (request, response, next) => {
    try {
      requirePurgeConfirmation(request.body || {});
      const deleted = repo.deleteAnnotation(Number(request.params.id));
      if (!deleted) {
        response.status(404).json({ error: "Annotation not found" });
        return;
      }
      response.json({ deleted: true });
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.get("/api/research-cards", (request, response, next) => {
    try {
      const paperId = request.query.paperId === undefined || request.query.paperId === ""
        ? undefined
        : Number(request.query.paperId);
      response.json(repo.listResearchCards(paperId).map(publicResearchCard));
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.post("/api/research-cards", (request, response, next) => {
    try {
      response.status(201).json(publicResearchCard(repo.createResearchCard(request.body || {})));
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.patch("/api/research-cards/:id", (request, response, next) => {
    try {
      const card = repo.updateResearchCard(Number(request.params.id), request.body || {});
      if (!card) {
        response.status(404).json({ error: "Research card not found" });
        return;
      }
      response.json(publicResearchCard(card));
    } catch (error) {
      if (error instanceof VersionConflictError) {
        response.status(409).json({ error: error.message });
        return;
      }
      respondToPaperStateError(error, response, next);
    }
  });

  app.delete("/api/research-cards/:id", (request, response, next) => {
    try {
      requirePurgeConfirmation(request.body || {});
      const deleted = repo.deleteResearchCard(Number(request.params.id));
      if (!deleted) {
        response.status(404).json({ error: "Research card not found" });
        return;
      }
      response.json({ deleted: true });
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.get("/api/duplicates", (_request, response) => {
    response.json({ groups: repo.listDuplicateGroups() });
  });

  app.post("/api/duplicates/scan", async (_request, response, next) => {
    try {
      const scanned = [];
      const missing = [];
      const rejected = [];
      const failed = [];
      for (const file of repo.listActivePaperFilesMissingHashes()) {
        const resolvedPath = resolveLibraryPdf(config.filesDir, file.stored_path);
        const label = scanPathLabel(config.filesDir, resolvedPath, file.stored_path);
        if (!resolvedPath) {
          rejected.push(label);
          continue;
        }
        try {
          const buffer = await readFile(resolvedPath);
          repo.updatePaperFileHash(file.id, fingerprintBuffer(buffer));
          scanned.push(label);
        } catch (error) {
          if (error.code === "ENOENT") missing.push(label);
          else failed.push(label);
        }
      }
      response.json({
        groups: repo.listDuplicateGroups(),
        scanned,
        missing,
        rejected,
        failed
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/papers/:id", (request, response, next) => {
    try {
      response.json(publicTrashPaper(repo.trashPaper(Number(request.params.id))));
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.get("/api/trash", (_request, response) => {
    response.json(repo.listTrashedPapers().map(publicTrashPaper));
  });

  app.post("/api/trash/:id/restore", (request, response, next) => {
    try {
      response.json(publicTrashPaper(repo.restorePaper(Number(request.params.id))));
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.delete("/api/trash/:id", (request, response, next) => {
    try {
      requirePurgeConfirmation(request.body || {});
      const purged = repo.purgePaper(Number(request.params.id));
      const cleanup = removeLibraryFiles(
        config.filesDir,
        purged.storedPaths,
        purged.protectedStoredPaths
      );
      response.json({ paper: publicTrashPaper(purged.paper), cleanup });
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.delete("/api/trash", (request, response, next) => {
    try {
      requirePurgeConfirmation(request.body || {});
      const cleanup = emptyCleanup();
      const result = repo.purgeAllTrashedPapers();
      appendCleanup(
        cleanup,
        removeLibraryFiles(config.filesDir, result.storedPaths, result.protectedStoredPaths)
      );
      response.json({ papers: result.papers.map(publicTrashPaper), cleanup });
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.patch("/api/papers/:id", (request, response, next) => {
    try {
      updatePaperResponse(repo, request, response, [...metadataFields, ...citationMetadataFields]);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/papers/:id/notes", (request, response, next) => {
    try {
      updatePaperResponse(repo, request, response, noteFields);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/papers/:id/citation", (request, response, next) => {
    try {
      validateExpectedVersion(request.body?.expectedVersion);
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        response.status(400).json({ error: "Paper id must be a positive integer" });
        return;
      }
      const paper = repo.updatePaperCitation(id, request.body || {});
      if (!paper) {
        response.status(404).json({ error: "Paper not found" });
        return;
      }
      response.json(publicPaper(paper));
    } catch (error) {
      if (error instanceof PaperNotFoundError) {
        response.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof VersionConflictError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof PaperStateError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof CitationKeyError || error instanceof CitationValidationError || error instanceof TypeError) {
        response.status(400).json({ error: error.message, missingFields: error.missingFields || undefined });
        return;
      }
      next(error);
    }
  });

  app.patch("/api/papers/:id/reading-progress", (request, response, next) => {
    try {
      const paper = repo.updateReadingProgress(Number(request.params.id), request.body || {});
      if (!paper) {
        response.status(404).json({ error: "Paper not found" });
        return;
      }
      response.json(publicPaper(paper));
    } catch (error) {
      if (error instanceof RangeError) {
        response.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof PaperStateError) {
        response.status(409).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post("/api/translate", async (request, response, next) => {
    try {
      const result = await translateText(
        {
          text: request.body.text || "",
          targetLanguage: request.body.targetLanguage || "zh-CN"
        },
        {
          enabled: config.translationEnabled ?? process.env.QPL_TRANSLATION_ENABLED === "1",
          provider: config.translationProvider ?? process.env.QPL_TRANSLATION_PROVIDER ?? "openai",
          apiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY,
          model: config.translationModel ?? process.env.QPL_TRANSLATION_MODEL,
          endpoint: config.translationEndpoint,
          geminiApiKey: config.geminiApiKey ?? process.env.GEMINI_API_KEY,
          geminiModel: config.geminiModel ?? process.env.QPL_GEMINI_MODEL,
          geminiEndpoint: config.geminiEndpoint,
          qwenApiKey: config.qwenApiKey ?? process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY,
          qwenModel: config.qwenModel ?? process.env.QPL_QWEN_MODEL ?? process.env.QPL_TRANSLATION_MODEL,
          qwenBaseUrl: config.qwenBaseUrl ?? process.env.QPL_QWEN_BASE_URL,
          qwenEndpoint: config.qwenEndpoint ?? process.env.QPL_QWEN_ENDPOINT,
          fetchImpl: config.translationFetch
        }
      );
      response.json(result);
    } catch (error) {
      if (error instanceof TranslationError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get("/api/papers/:id/file", (request, response, next) => {
    try {
      const paper = repo.getPaper(Number(request.params.id));
      if (!paper) {
        response.status(404).json({ error: "Paper not found" });
        return;
      }

      const pdfPath = resolveLibraryPdf(config.filesDir, paper.storedPath);
      if (!pdfPath || !existsSync(pdfPath)) {
        response.status(404).json({ error: "Source PDF not found" });
        return;
      }

      response.type("application/pdf");
      response.setHeader("Content-Disposition", `inline; filename="${paper.storedFilename || "paper.pdf"}"`);
      response.sendFile(pdfPath);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/export/:format", (request, response) => {
    const papers = repo.searchPapers();
    const format = request.params.format;
    if (format === "bibtex") {
      response.type("application/x-bibtex").send(exportBibtex(papers));
      return;
    }
    if (format === "csv") {
      response.type("text/csv").send(exportCsv(papers));
      return;
    }
    if (format === "markdown") {
      response.type("text/markdown").send(exportMarkdown(papers));
      return;
    }
    response.status(404).json({ error: "Unsupported export format" });
  });

  app.get("/api/citations/export", (request, response, next) => {
    try {
      const format = citationExportFormats[request.query.format];
      if (!format) {
        response.status(400).json({ error: "Unsupported citation export format" });
        return;
      }
      const papers = citationExportPapers(repo, request.query);
      response
        .status(200)
        .set("Content-Type", format.contentType)
        .set("Content-Disposition", `attachment; filename="${format.filename}"`)
        .send(format.render(papers));
    } catch (error) {
      if (error.status === 404) {
        response.status(404).json({ error: error.message });
        return;
      }
      if (error.status === 400 || error instanceof TypeError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(config.staticDir, "index.html"));
  });

  app.use((error, _request, response, _next) => {
    response.status(500).json({ error: "服务器内部错误" });
  });

  return app;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  mkdirSync(defaultConfig.filesDir, { recursive: true });
  const app = createApp();
  app.listen(defaultConfig.port, () => {
    console.log(`Quaternary Paper Library running at http://127.0.0.1:${defaultConfig.port}`);
  });
}
