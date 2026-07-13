import path from "node:path";
import { fileURLToPath } from "node:url";

import { initDb } from "../src/database.js";
import { PaperRepository } from "../src/repository.js";

function positiveId(value) {
  if (!/^\d+$/.test(String(value))) throw new Error("paper id must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("paper id must be a positive integer");
  return id;
}

export function parseArgs(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--paper") return { paperId: positiveId(argv[1]) };
  throw new Error("unknown argument");
}

function activePaperIds(repo) {
  return repo.withDb((db) => db.prepare(`
    SELECT id FROM papers
    WHERE deleted_at IS NULL AND merged_into_id IS NULL
    ORDER BY id ASC
  `).all().map((row) => row.id));
}

export function runRebuildKnowledge({
  dbPath = process.env.QPL_DB_PATH || path.join(process.cwd(), "library", "library.sqlite"),
  paperId,
  output = (row) => console.log(JSON.stringify(row))
} = {}) {
  initDb(dbPath);
  const repo = new PaperRepository(dbPath);
  const ids = paperId === undefined ? activePaperIds(repo) : [positiveId(paperId)];
  const results = [];
  for (const id of ids) {
    try {
      const paper = repo.getPaper(id);
      if (!paper || paper.deletedAt !== null || paper.mergedIntoId !== null) throw new Error("paper is not active");
      const counts = repo.rebuildPaperKnowledge(id);
      const result = { paperId: id, status: "rebuilt", ...counts };
      results.push(result);
      output(result);
    } catch {
      const result = { paperId: id, status: "failed", references: 0, assets: 0, citationRelations: 0 };
      results.push(result);
      output(result);
    }
  }
  return { results, failed: results.filter((result) => result.status === "failed").map((result) => result.paperId) };
}

export function main(argv = process.argv.slice(2)) {
  const result = runRebuildKnowledge(parseArgs(argv));
  return result.failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "knowledge rebuild failed");
    process.exitCode = 1;
  }
}
