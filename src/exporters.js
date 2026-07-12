import { exportCslJson, exportRis, generateCitationKey } from "./citations.js";

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function bibtexKey(paper, usedKeys) {
  const key = paper.citationKey && usedKeys.has(paper.citationKey)
    ? generateCitationKey({ ...paper, citationKey: "" }, usedKeys)
    : generateCitationKey(paper, usedKeys);
  usedKeys.add(key);
  return key;
}

function bibtexEscape(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replaceAll("&", "\\&")
    .replaceAll("%", "\\%")
    .replaceAll("$", "\\$")
    .replaceAll("#", "\\#")
    .replaceAll("_", "\\_")
    .replace(/[\r\n\t]+/g, " ");
}

function bibtexType(type) {
  return { article: "article", book: "book", chapter: "inbook", thesis: "phdthesis", report: "techreport", conference: "inproceedings", other: "misc" }[type] || "article";
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function exportBibtex(papers) {
  const usedKeys = new Set();
  return papers
    .map((paper) => {
      const key = bibtexKey(paper, usedKeys);
      const fields = [
        ["title", paper.title],
        ["author", arrayValue(paper.authors).join(" and ")],
        ["journal", paper.journal],
        ["year", paper.year],
        ["volume", paper.volume],
        ["number", paper.issue],
        ["pages", paper.pages],
        ["publisher", paper.publisher],
        ["doi", paper.doi],
        ["keywords", arrayValue(paper.keywords).join("; ")]
      ].filter(([, value]) => value);
      return `@${bibtexType(paper.publicationType)}{${key},\n${fields
        .map(([field, value]) => `  ${field} = {${bibtexEscape(value)}}`)
        .join(",\n")}\n}`;
    })
    .join("\n\n");
}

export { exportCslJson, exportRis };

export function exportCsv(papers) {
  const columns = [
    "title",
    "authors",
    "year",
    "journal",
    "doi",
    "keywords",
    "themes",
    "regions",
    "periods",
    "materials",
    "methods",
    "proxies",
    "readingStatus"
  ];
  const rows = papers.map((paper) => columns.map((column) => csvEscape(paper[column])).join(","));
  return [columns.join(","), ...rows].join("\n");
}

export function exportMarkdown(papers) {
  return papers
    .map((paper) => {
      return [
        `## ${paper.title || "Untitled paper"}`,
        "",
        `- Authors: ${arrayValue(paper.authors).join(", ")}`,
        `- Year: ${paper.year || ""}`,
        `- Journal: ${paper.journal || ""}`,
        `- DOI: ${paper.doi || ""}`,
        `- Keywords: ${arrayValue(paper.keywords).join(", ")}`,
        `- Classification: ${[
          ...arrayValue(paper.themes),
          ...arrayValue(paper.regions),
          ...arrayValue(paper.periods),
          ...arrayValue(paper.materials),
          ...arrayValue(paper.methods),
          ...arrayValue(paper.proxies)
        ].join(", ")}`,
        "",
        "### Abstract",
        paper.abstract || "",
        "",
        "### Note Card",
        `- Research question: ${paper.notesResearchQuestion || ""}`,
        `- Region: ${paper.notesRegion || ""}`,
        `- Materials and methods: ${paper.notesMaterialsMethods || ""}`,
        `- Chronology: ${paper.notesChronology || ""}`,
        `- Core findings: ${paper.notesCoreFindings || ""}`,
        `- Limits: ${paper.notesLimits || ""}`,
        `- Quote points: ${paper.notesQuotePoints || ""}`,
        `- Personal notes: ${paper.notesPersonal || ""}`
      ].join("\n");
    })
    .join("\n\n");
}
