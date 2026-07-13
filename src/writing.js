import { formatApa7, formatGbt7714, formatInTextCitation } from "./citations.js";

const CITATION_STYLES = new Set(["gbt7714", "apa7"]);

function text(value, field, maximum, { required = false, multiline = false } = {}) {
  const normalized = String(value ?? "").normalize("NFKC");
  const output = multiline ? normalized.replace(/\r\n/g, "\n").trim() : normalized.replace(/\s+/g, " ").trim();
  if ((required && !output) || output.length > maximum) throw new TypeError(`${field} is invalid`);
  return output;
}

function paperIds(value) {
  if (!Array.isArray(value)) throw new TypeError("citedPaperIds must be an array");
  const ids = [];
  for (const item of value) {
    if (!Number.isSafeInteger(item) || item < 1) throw new TypeError("cited paper id is invalid");
    if (!ids.includes(item)) ids.push(item);
  }
  if (ids.length > 1000) throw new TypeError("too many cited papers");
  return ids;
}

export function normalizeWritingDraftInput(input = {}, { partial = false } = {}) {
  const output = {};
  if (!partial || Object.hasOwn(input, "title")) output.title = text(input.title, "title", 300);
  if (!partial || Object.hasOwn(input, "body")) output.body = text(input.body, "body", 200000, { multiline: true });
  if (!partial || Object.hasOwn(input, "citationStyle")) {
    output.citationStyle = String(input.citationStyle || "gbt7714").trim().toLowerCase();
    if (!CITATION_STYLES.has(output.citationStyle)) throw new TypeError("citationStyle is invalid");
  }
  if (!partial || Object.hasOwn(input, "citedPaperIds")) output.citedPaperIds = paperIds(input.citedPaperIds || []);
  return output;
}

export function normalizeWritingEvidenceInput(input = {}) {
  const paperId = Number(input.paperId);
  const pageNumber = Number(input.pageNumber);
  if (!Number.isSafeInteger(paperId) || paperId < 1) throw new TypeError("paperId is invalid");
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new TypeError("pageNumber is invalid");
  return { paperId, pageNumber, quote: text(input.quote, "quote", 20000, { required: true, multiline: true }) };
}

export function buildEvidenceInsert({ paper, quote, pageNumber, citationStyle = "gbt7714" } = {}) {
  const style = CITATION_STYLES.has(citationStyle) ? citationStyle : "gbt7714";
  const quoteLines = text(quote, "quote", 20000, { required: true, multiline: true })
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const location = style === "apa7" ? `p. ${pageNumber}` : `第 ${pageNumber} 页`;
  return `${quoteLines}\n\n${formatInTextCitation(paper, style)}，${location}`;
}

export function formatWritingBibliography(papers = [], citationStyle = "gbt7714") {
  const formatter = citationStyle === "apa7" ? formatApa7 : formatGbt7714;
  return papers.map((paper, index) => `${index + 1}. ${formatter(paper)}`).join("\n");
}

export { CITATION_STYLES };
