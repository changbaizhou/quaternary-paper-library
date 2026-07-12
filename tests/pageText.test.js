import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { initDb } from "../src/database.js";
import { extractOcrPages } from "../src/ocr.js";
import {
  extractPdfPages,
  indexPaperSource,
  mergePdfAndOcrPages,
  normalizePageText
} from "../src/pageText.js";
import { PaperRepository } from "../src/repository.js";

async function makeTwoPagePdf(filePath) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [text, y] of [["Page one alpha", 700], ["Page two beta", 700]]) {
    const page = document.addPage([600, 800]);
    page.drawText(text, { x: 50, y, size: 18, font });
  }
  await writeFile(filePath, await document.save());
}

test("normalizePageText keeps meaningful line boundaries and trims whitespace", () => {
  assert.equal(normalizePageText("  Alpha\r\n\r\n Beta\t gamma  "), "Alpha\nBeta gamma");
});

test("extractPdfPages extracts a valid PDF one page at a time", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-page-text-"));
  const pdfPath = path.join(dir, "two-page.pdf");
  try {
    await makeTwoPagePdf(pdfPath);
    const pages = await extractPdfPages(pdfPath);
    assert.deepEqual(pages.map(({ pageNumber, source, language }) => ({ pageNumber, source, language })), [
      { pageNumber: 1, source: "pdf", language: "" },
      { pageNumber: 2, source: "pdf", language: "" }
    ]);
    assert.match(pages[0].text, /Page one alpha/);
    assert.match(pages[1].text, /Page two beta/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergePdfAndOcrPages replaces sparse PDF pages and avoids duplicate text", () => {
  const merged = mergePdfAndOcrPages(
    [
      { pageNumber: 1, text: "short", source: "pdf", language: "" },
      { pageNumber: 2, text: "A complete page", source: "pdf", language: "" }
    ],
    [
      { pageNumber: 1, text: "OCR recovered page one", source: "ocr", language: "eng" },
      { pageNumber: 2, text: "A complete page", source: "ocr", language: "eng" },
      { pageNumber: 3, text: "OCR-only page three", source: "ocr", language: "eng" }
    ],
    8
  );

  assert.deepEqual(merged, [
    { pageNumber: 1, text: "OCR recovered page one", source: "ocr", language: "eng" },
    { pageNumber: 2, text: "A complete page", source: "pdf", language: "" },
    { pageNumber: 3, text: "OCR-only page three", source: "ocr", language: "eng" }
  ]);
});

test("extractOcrPages renders once and returns page-level OCR results", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-ocr-pages-"));
  const calls = [];
  try {
    const pages = await extractOcrPages(path.join(dir, "scan.pdf"), {
      enabled: true,
      pages: 3,
      workRoot: dir,
      commandExists: async () => true,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (command === "pdftoppm") {
          await writeFile(`${args.at(-1)}-1.png`, "");
          await writeFile(`${args.at(-1)}-3.png`, "");
          return { stdout: "", stderr: "" };
        }
        return { stdout: args[0].endsWith("-1.png") ? "Sparse page one" : "Sparse page three", stderr: "" };
      }
    });
    assert.deepEqual(pages, [
      { pageNumber: 1, text: "Sparse page one", source: "ocr", language: "chi_sim+eng" },
      { pageNumber: 3, text: "Sparse page three", source: "ocr", language: "chi_sim+eng" }
    ]);
    assert.equal(calls.filter(({ command }) => command === "pdftoppm").length, 1);
    assert.equal(calls.filter(({ command }) => command === "tesseract").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replacePaperPages enforces active papers, continuous pages, and non-empty replacement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-page-repository-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const paperId = repo.confirmDraft(repo.createDraft({ title: "Indexed paper", classification: {} }));
    const pages = [
      { pageNumber: 1, text: "One", source: "pdf", language: "" },
      { pageNumber: 2, text: "Two", source: "mixed", language: "eng" }
    ];
    assert.deepEqual(repo.replacePaperPages(paperId, pages), { pageCount: 2, sources: { pdf: 1, ocr: 0, mixed: 1 } });
    assert.deepEqual(repo.getPaperIndexState(paperId), { pageCount: 2, sources: { pdf: 1, ocr: 0, mixed: 1 } });
    assert.deepEqual(repo.listPaperPages(paperId).map((page) => page.pageNumber), [1, 2]);
    assert.equal(repo.getPaperPage(paperId, 2).characterCount, 3);
    assert.throws(() => repo.replacePaperPages(paperId, []), /empty/);
    assert.throws(() => repo.replacePaperPages(paperId, [{ pageNumber: 1, text: "x", source: "pdf" }, { pageNumber: 3, text: "y", source: "pdf" }]), /continuous/);
    assert.throws(() => repo.replacePaperPages(paperId, [{ pageNumber: 1, text: "x", source: "pdf" }, { pageNumber: 1, text: "y", source: "pdf" }]), /unique|duplicate/);
    repo.trashPaper(paperId);
    assert.throws(() => repo.replacePaperPages(paperId, pages), /active/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("indexPaperSource extracts outside replacement and preserves old pages on failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-page-index-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const paperId = repo.confirmDraft(repo.createDraft({ title: "Indexed paper", classification: {} }));
    repo.replacePaperPages(paperId, [{ pageNumber: 1, text: "old text", source: "pdf", language: "" }]);

    await assert.rejects(
      indexPaperSource({
        paperId,
        pdfPath: path.join(dir, "source.pdf"),
        repo,
        extractPdfPages: async () => { throw new Error(`failed at ${path.join(dir, "private.pdf")}`); },
        extractOcrPages: async () => []
      }),
      /failed/
    );
    assert.deepEqual(repo.listPaperPages(paperId).map((page) => page.text), ["old text"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
