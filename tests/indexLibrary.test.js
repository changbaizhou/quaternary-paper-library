import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { initDb } from "../src/database.js";
import { extractPdfPages } from "../src/pageText.js";
import { PaperRepository } from "../src/repository.js";
import { runIndexLibrary } from "../scripts/indexLibrary.js";

async function makePdf(filePath, pages = ["Page one text", "Page two text"]) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, text] of pages.entries()) {
    const page = document.addPage([600, 800]);
    page.drawText(text, { x: 50, y: 700, size: 18, font });
  }
  await writeFile(filePath, await document.save());
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-index-library-"));
  const filesDir = path.join(dir, "files");
  const backupsDir = path.join(dir, "backups");
  const dbPath = path.join(dir, "library.sqlite");
  await mkdir(filesDir, { recursive: true });
  await mkdir(backupsDir, { recursive: true });
  await makePdf(path.join(filesDir, "one.pdf"));
  await makePdf(path.join(filesDir, "two.pdf"), ["Second paper page one"]);
  initDb(dbPath, { backupsDir });
  const repo = new PaperRepository(dbPath);
  const createPaper = (title, storedPath) => {
    const draftId = repo.createDraft({ title, storedPath, storedFilename: path.basename(storedPath), classification: {} });
    return repo.confirmDraft(draftId);
  };
  return { dir, dbPath, filesDir, backupsDir, repo, createPaper };
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

test("bulk indexing creates its backup before the first paper is processed", async () => {
  const { dir, dbPath, filesDir, backupsDir, repo, createPaper } = await fixture();
  try {
    const paperId = createPaper("First private title", "one.pdf");
    let backupCountAtExtraction = 0;
    const output = [];
    const result = await runIndexLibrary({
      dbPath,
      filesDir,
      backupsDir,
      output: (line) => output.push(line),
      extractPdfPages: async (pdfPath) => {
        backupCountAtExtraction = repo.listBackupRecords().length;
        return extractPdfPages(pdfPath);
      }
    });
    assert.equal(backupCountAtExtraction, 1);
    assert.deepEqual(result.results, [{ paperId, status: "indexed", pageCount: 2 }]);
    assert.deepEqual(output, [{ paperId, status: "indexed", pageCount: 2 }]);
    assert.equal(repo.listBackupRecords()[0].backupType, "database");
  } finally {
    await cleanup(dir);
  }
});

test("bulk indexing resolves legacy library paths under the configured files directory", async () => {
  const { dir, dbPath, filesDir, backupsDir, repo, createPaper } = await fixture();
  try {
    const paperId = createPaper("Portable legacy path paper", "library/files/one.pdf");
    const result = await runIndexLibrary({
      dbPath,
      filesDir,
      backupsDir,
      output: () => {},
      extractPdfPages: async (pdfPath) => extractPdfPages(pdfPath)
    });

    assert.deepEqual(result.results, [{ paperId, status: "indexed", pageCount: 2 }]);
  } finally {
    await cleanup(dir);
  }
});

test("one failed paper does not block later papers and does not replace old pages", async () => {
  const { dir, dbPath, filesDir, backupsDir, repo, createPaper } = await fixture();
  try {
    const firstId = createPaper("First private title", "one.pdf");
    const secondId = createPaper("Second private notes", "two.pdf");
    let calls = 0;
    const result = await runIndexLibrary({
      dbPath,
      filesDir,
      backupsDir,
      output: () => {},
      extractPdfPages: async (pdfPath) => {
        calls += 1;
        if (pdfPath.endsWith("one.pdf")) throw new Error("private extraction failure");
        return extractPdfPages(pdfPath);
      }
    });
    assert.deepEqual(result.results, [
      { paperId: firstId, status: "failed", pageCount: 0 },
      { paperId: secondId, status: "indexed", pageCount: 1 }
    ]);
    assert.equal(calls, 2);
    assert.equal(repo.getPaperIndexState(secondId).pageCount, 1);

    repo.replacePaperPages(firstId, [{ pageNumber: 1, text: "old indexed text", source: "pdf", language: "" }]);
    const failedForced = await runIndexLibrary({
      dbPath,
      filesDir,
      backupsDir,
      paperId: firstId,
      output: () => {},
      extractPdfPages: async () => { throw new Error("private extraction failure"); }
    });
    assert.deepEqual(failedForced.results, [{ paperId: firstId, status: "failed", pageCount: 1 }]);
    assert.deepEqual(repo.listPaperPages(firstId).map((page) => page.text), ["old indexed text"]);

    const later = await runIndexLibrary({
      dbPath,
      filesDir,
      backupsDir,
      output: () => {},
      extractPdfPages: async (pdfPath) => extractPdfPages(pdfPath)
    });
    assert.deepEqual(later.results, []);
  } finally {
    await cleanup(dir);
  }
});

test("default rerun skips indexed papers while retry-failed selects remaining papers", async () => {
  const { dir, dbPath, filesDir, backupsDir, repo, createPaper } = await fixture();
  try {
    const indexedId = createPaper("Title must not appear in output", "one.pdf");
    const failedId = createPaper("Notes must not appear in output", "two.pdf");
    repo.replacePaperPages(indexedId, [{ pageNumber: 1, text: "already indexed", source: "pdf", language: "" }]);
    const output = [];
    const result = await runIndexLibrary({
      dbPath,
      filesDir,
      backupsDir,
      retryFailed: true,
      output: (line) => output.push(line),
      extractPdfPages: async (pdfPath) => extractPdfPages(pdfPath)
    });
    assert.deepEqual(result.results.map(({ paperId }) => paperId), [failedId]);
    assert.equal(output.some((line) => JSON.stringify(line).includes("Title must")), false);
    assert.equal(output.some((line) => JSON.stringify(line).includes("Notes must")), false);
    assert.equal(repo.getPaperIndexState(indexedId).pageCount, 1);

    const secondRun = await runIndexLibrary({ dbPath, filesDir, backupsDir, output: (line) => output.push(line) });
    assert.deepEqual(secondRun.results, []);
  } finally {
    await cleanup(dir);
  }
});

test("unknown CLI arguments fail and CLI output contains only safe fields", async () => {
  const unknown = spawn(process.execPath, ["scripts/indexLibrary.js", "--unknown"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const unknownOutput = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    unknown.stdout.setEncoding("utf8");
    unknown.stderr.setEncoding("utf8");
    unknown.stdout.on("data", (chunk) => { stdout += chunk; });
    unknown.stderr.on("data", (chunk) => { stderr += chunk; });
    unknown.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.notEqual(unknownOutput.code, 0);
  assert.doesNotMatch(`${unknownOutput.stdout}${unknownOutput.stderr}`, /title|notes|stored_path|[A-Z]:\\/i);

  const { dir, dbPath, filesDir, backupsDir, createPaper } = await fixture();
  try {
    const paperId = createPaper("Never print this title", "one.pdf");
    const child = spawn(process.execPath, ["scripts/indexLibrary.js", "--paper", String(paperId)], {
      cwd: path.resolve("."),
      env: { ...process.env, NODE_NO_WARNINGS: "1", QPL_DB_PATH: dbPath, QPL_FILES_DIR: filesDir, QPL_BACKUPS_DIR: backupsDir },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(output.code, 0);
    const lines = output.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(lines, [{ paperId, status: "indexed", pageCount: 2 }]);
    assert.doesNotMatch(output.stdout, /Never print|one\.pdf|[A-Z]:\\/i);
    assert.equal(output.stderr, "");
  } finally {
    await cleanup(dir);
  }
});
