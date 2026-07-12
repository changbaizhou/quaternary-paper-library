import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const PAGE_SOURCES = new Set(["pdf", "ocr", "mixed"]);
const standardFontDataPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "pdfjs-dist",
  "standard_fonts"
).replaceAll(path.sep, "/") + "/";

export function normalizePageText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function meaningfulLength(text) {
  return Array.from(normalizePageText(text).replace(/\s/gu, "")).length;
}

function pageRecord(page, defaultSource) {
  const pageNumber = Number(page?.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;
  const source = PAGE_SOURCES.has(page?.source) ? page.source : defaultSource;
  const text = normalizePageText(page?.text);
  return {
    pageNumber,
    text,
    source,
    language: String(page?.language || "")
  };
}

function mergeCompleteTexts(pdfPage, ocrPage) {
  const pdfText = normalizePageText(pdfPage.text);
  const ocrText = normalizePageText(ocrPage.text);
  if (!pdfText) return { ...ocrPage, text: ocrText, source: "ocr" };
  if (!ocrText) return { ...pdfPage, text: pdfText };

  const pdfComparable = pdfText.replace(/\s/gu, "");
  const ocrComparable = ocrText.replace(/\s/gu, "");
  if (pdfComparable === ocrComparable) return { ...pdfPage, text: pdfText };
  if (pdfComparable.includes(ocrComparable)) return { ...pdfPage, text: pdfText };
  if (ocrComparable.includes(pdfComparable)) {
    return { ...ocrPage, text: ocrText, source: "mixed", language: ocrPage.language || pdfPage.language };
  }

  const pdfWords = new Set(pdfText.toLocaleLowerCase().split(/\s+/u).filter(Boolean));
  const ocrSupplement = ocrText
    .split(/\s+/u)
    .filter((word) => !pdfWords.has(word.toLocaleLowerCase()))
    .join(" ");
  if (!ocrSupplement) return { ...pdfPage, text: pdfText };
  return {
    pageNumber: pdfPage.pageNumber,
    text: normalizePageText(`${pdfText}\n${ocrSupplement}`),
    source: "mixed",
    language: ocrPage.language || pdfPage.language
  };
}

export function mergePdfAndOcrPages(pdfPages = [], ocrPages = [], threshold = 80) {
  const pdfMap = new Map(pdfPages.map((page) => pageRecord(page, "pdf")).filter(Boolean).map((page) => [page.pageNumber, page]));
  const ocrMap = new Map(ocrPages.map((page) => pageRecord(page, "ocr")).filter(Boolean).map((page) => [page.pageNumber, page]));
  const pageNumbers = [...new Set([...pdfMap.keys(), ...ocrMap.keys()])].sort((left, right) => left - right);

  return pageNumbers.map((pageNumber) => {
    const pdfPage = pdfMap.get(pageNumber);
    const ocrPage = ocrMap.get(pageNumber);
    if (!pdfPage) return ocrPage;
    if (!ocrPage || !ocrPage.text) return pdfPage;
    if (meaningfulLength(pdfPage.text) < threshold && ocrPage.text) {
      return { ...ocrPage, source: "ocr" };
    }
    return mergeCompleteTexts(pdfPage, ocrPage);
  });
}

export async function extractPdfPages(pdfPath, _options = {}) {
  const data = new Uint8Array(await readFile(pdfPath));
  const document = await pdfjs.getDocument({
    data,
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl: standardFontDataPath
  }).promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (item.str) text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      pages.push({ pageNumber, text: normalizePageText(text), source: "pdf", language: "" });
      page.cleanup?.();
    }
  } finally {
    await document.cleanup?.();
    await document.destroy?.();
  }
  return pages;
}

function normalizeOcrResult(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.pages) ? result.pages : [];
}

export async function indexPaperSource({
  paperId,
  pdfPath,
  repo,
  extractPdfPages: extractPdf = extractPdfPages,
  extractOcrPages: extractOcr,
  threshold = 80,
  ocr = {}
}) {
  if (!repo || !pdfPath) throw new TypeError("An index repository and PDF path are required");
  const pdfPages = await extractPdf(pdfPath);
  let ocrPages = [];
  const needsOcr = pdfPages.length === 0 || pdfPages.some((page) => meaningfulLength(page.text) < threshold);
  if (needsOcr && extractOcr) {
    ocrPages = normalizeOcrResult(await extractOcr(pdfPath, ocr));
  }
  const pages = mergePdfAndOcrPages(pdfPages, ocrPages, threshold);
  if (pages.length === 0) throw new Error("No page text was extracted");
  return repo.replacePaperPages(paperId, pages);
}
