import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabaseBackup } from "../src/backups.js";
import { initDb } from "../src/database.js";
import { resolveLibraryPdf } from "../src/fileStorage.js";
import { extractPdfPages } from "../src/pageText.js";
import { PaperRepository } from "../src/repository.js";
import { createPaperIndexService } from "../src/server.js";

function positiveId(value) {
  if (!/^\d+$/.test(String(value))) throw new Error("paper id must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("paper id must be a positive integer");
  return id;
}

export function parseArgs(argv) {
  const options = { retryFailed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--retry-failed") {
      options.retryFailed = true;
      continue;
    }
    if (argument === "--paper") {
      if (options.paperId !== undefined || index + 1 >= argv.length) throw new Error("--paper requires one positive id");
      options.paperId = positiveId(argv[++index]);
      continue;
    }
    throw new Error("unknown argument");
  }
  return options;
}

function papersWithoutPages(repo) {
  return repo.withDb((db) => db.prepare(`
    SELECT p.id
    FROM papers AS p
    WHERE p.deleted_at IS NULL
      AND p.merged_into_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM paper_pages AS pages WHERE pages.paper_id = p.id
      )
    ORDER BY p.id ASC
  `).all().map((row) => row.id));
}

function requireActivePaper(repo, paperId) {
  const paper = repo.getPaper(paperId);
  if (!paper || paper.deletedAt !== null || paper.mergedIntoId !== null) {
    throw new Error("paper is not active");
  }
  return paper;
}

function safeResult(paperId, status, pageCount) {
  return { paperId, status, pageCount };
}

export async function runIndexLibrary({
  dbPath = process.env.QPL_DB_PATH || path.join(process.cwd(), "library", "library.sqlite"),
  filesDir = process.env.QPL_FILES_DIR || path.join(process.cwd(), "library", "files"),
  backupsDir = process.env.QPL_BACKUPS_DIR || path.join(path.dirname(dbPath), "backups"),
  paperId,
  retryFailed = false,
  extractPdfPages: extractPdf = extractPdfPages,
  extractOcrPages,
  ocr,
  output = (result) => console.log(JSON.stringify(result))
} = {}) {
  initDb(dbPath, { backupsDir });
  const repo = new PaperRepository(dbPath);
  const backup = createDatabaseBackup({ dbPath, backupsDir, reason: "bulk-index" });
  repo.createBackupRecord({ ...backup, backupType: "database" });

  const paperIds = paperId === undefined
    ? papersWithoutPages(repo)
    : [requireActivePaper(repo, positiveId(paperId)).id];
  const indexPaper = createPaperIndexService({
    repo,
    filesDir,
    extractPdfPages: extractPdf,
    ...(extractOcrPages ? { extractOcrPages } : {}),
    ...(ocr ? { ocr } : {})
  });
  const results = [];

  for (const id of paperIds) {
    let status = "failed";
    try {
      const paper = requireActivePaper(repo, id);
      const sourcePath = resolveLibraryPdf(filesDir, paper.storedPath);
      if (!sourcePath || !existsSync(sourcePath)) throw new Error("source PDF not found");
      const result = await indexPaper(id);
      if (result.indexState === "indexed") status = "indexed";
    } catch {
      status = "failed";
    }
    const pageCount = repo.getPaperIndexState(id).pageCount;
    const safe = safeResult(id, status, pageCount);
    results.push(safe);
    output(safe);
  }

  return { results, failed: results.filter((result) => result.status === "failed").map((result) => result.paperId) };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await runIndexLibrary(options);
  return result.failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exitCode = code).catch((error) => {
    console.error(error instanceof Error ? error.message : "indexing failed");
    process.exitCode = 1;
  });
}
