import express from "express";
import multer from "multer";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfig } from "./config.js";
import { initDb } from "./database.js";
import { exportBibtex, exportCsv, exportMarkdown } from "./exporters.js";
import { lookupDoiMetadata, lookupTitleMetadata } from "./metadata.js";
import { extractOcrText as defaultExtractOcrText } from "./ocr.js";
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
import {
  PaperNotFoundError,
  PaperRepository,
  PaperStateError,
  DraftNotFoundError,
  VersionConflictError
} from "./repository.js";
import { classifyText } from "./taxonomy.js";
import { translateText, TranslationError } from "./translation.js";

const upload = multer({ storage: multer.memoryStorage() });
const arrayPaperFields = new Set([
  "authors", "keywords", "themes", "regions", "periods", "materials", "methods", "proxies"
]);

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
    response.json(paper);
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
  } catch (error) {
    text = `PDF text extraction failed: ${error.message}`;
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
  next(error);
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
    title: paper.title,
    year: paper.year,
    deletedAt: paper.deletedAt,
    version: paper.version,
    status: paper.deletedAt ? "trash" : "active"
  };
}

export function createApp(options = {}) {
  const config = { ...defaultConfig, ...options };
  const enableUploadLookup = config.enableUploadLookup ?? true;
  mkdirSync(config.filesDir, { recursive: true });
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  initDb(config.dbPath);
  const repo = new PaperRepository(config.dbPath);
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use("/vendor/pdfjs-dist", express.static(path.join(process.cwd(), "node_modules", "pdfjs-dist")));
  app.use(express.static(config.staticDir));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/api/drafts/from-text", async (request, response, next) => {
    try {
      const draft = await createDraftFromText({
        repo,
        text: request.body.text || "",
        filename: request.body.filename || "text-import.txt",
        enableLookup: Boolean(request.body.enableLookup)
      });
      response.status(201).json(draft);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/uploads", upload.array("files"), async (request, response, next) => {
    try {
      const drafts = [];
      const year = new Date().getFullYear();
      const targetDir = path.join(config.filesDir, String(year));
      mkdirSync(targetDir, { recursive: true });

      for (const file of request.files || []) {
        const fileSha256 = fingerprintBuffer(file.buffer);
        const decodedOriginalName = decodePossiblyMojibakeFilename(file.originalname);
        const extension = path.extname(decodedOriginalName) || ".pdf";
        const storedFilename = `${Date.now()}-${slugify(path.basename(decodedOriginalName, extension))}${extension}`;
        const targetPath = path.join(targetDir, storedFilename);
        writeFileSync(targetPath, file.buffer);

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
        drafts.push(draft);
      }

      response.status(201).json(drafts);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/drafts", (_request, response) => {
    response.json(repo.listPendingDrafts());
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

  app.post("/api/drafts/:id/confirm", (request, response, next) => {
    try {
      const paperId = repo.confirmDraft(Number(request.params.id), request.body || {});
      response.status(201).json(repo.getPaper(paperId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/papers", (request, response) => {
    response.json(
      repo.searchPapers({
        query: request.query.query || "",
        filters: parseFilters(request.query)
      })
    );
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
      response.json(publicPaper(repo.trashPaper(Number(request.params.id))));
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.get("/api/trash", (_request, response) => {
    response.json(repo.listTrashedPapers().map(publicPaper));
  });

  app.post("/api/trash/:id/restore", (request, response, next) => {
    try {
      response.json(publicPaper(repo.restorePaper(Number(request.params.id))));
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
      response.json({ paper: publicPaper(purged.paper), cleanup });
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
      response.json({ papers: result.papers.map(publicPaper), cleanup });
    } catch (error) {
      respondToPaperStateError(error, response, next);
    }
  });

  app.patch("/api/papers/:id", (request, response, next) => {
    try {
      updatePaperResponse(repo, request, response, metadataFields);
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

  app.patch("/api/papers/:id/reading-progress", (request, response, next) => {
    try {
      const paper = repo.updateReadingProgress(Number(request.params.id), request.body || {});
      if (!paper) {
        response.status(404).json({ error: "Paper not found" });
        return;
      }
      response.json(paper);
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

  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(config.staticDir, "index.html"));
  });

  app.use((error, _request, response, _next) => {
    response.status(500).json({ error: error.message || "Internal server error" });
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
