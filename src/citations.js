const PUBLICATION_TYPES = new Set(["article", "book", "chapter", "thesis", "report", "conference", "other"]);

function list(value) {
  return Array.isArray(value) ? value.filter((item) => String(item || "").trim()) : [];
}

function clean(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function firstWord(value) {
  return clean(value).normalize("NFKC").match(/[\p{L}\p{N}]+/gu)?.[0] || "paper";
}

function keyPart(value, fallback) {
  const result = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[\p{L}\p{N}]+/gu)?.join("")
    .toLocaleLowerCase("en-US");
  return result || fallback;
}

function isCjk(value) {
  return /[\p{Script=Han}]/u.test(value);
}

function authorFamily(author) {
  const value = clean(author);
  if (!value) return "paper";
  if (value.includes(",")) return keyPart(value.split(",", 1)[0], "author");
  if (isCjk(value)) return keyPart(value.replace(/\s+/g, ""), "author");
  const parts = value.split(/\s+/).filter(Boolean);
  return keyPart(parts.at(-1) || value, "author");
}

function authorParts(author) {
  const value = clean(author);
  if (!value) return null;
  if (value.includes(",")) {
    const [family, ...given] = value.split(",");
    return { family: clean(family), given: clean(given.join(",")) };
  }
  const compact = value.replace(/\s+/g, "");
  if (isCjk(compact)) {
    return { family: compact.slice(0, 1), given: compact.slice(1) };
  }
  const parts = value.split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? { family: parts.at(-1), given: parts.slice(0, -1).join(" ") }
    : { family: parts[0], given: "" };
}

function yearText(paper) {
  const year = String(paper?.year ?? "").trim();
  return /^\d{4}$/.test(year) ? year : "n.d.";
}

function keyYear(paper) {
  return yearText(paper) === "n.d." ? "nd" : yearText(paper);
}

function existingSet(existingKeys) {
  if (existingKeys instanceof Set) return new Set([...existingKeys].map(String));
  return new Set(Array.from(existingKeys || [], (value) => String(value)));
}

export function generateCitationKey(paper = {}, existingKeys = []) {
  const current = clean(paper.citationKey);
  if (current) return current;
  const base = `${authorFamily(list(paper.authors)[0])}${keyYear(paper)}${keyPart(firstWord(paper.title), "paper")}`;
  const used = existingSet(existingKeys);
  if (!used.has(base)) return base;
  for (let index = 0; index < 26; index += 1) {
    const candidate = `${base}${String.fromCharCode(97 + index)}`;
    if (!used.has(candidate)) return candidate;
  }
  let suffix = 1;
  while (used.has(`${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

function requiredFields(type) {
  switch (type) {
    case "article": return ["journal"];
    case "book": return ["publisher"];
    case "chapter": return ["journal", "publisher"];
    case "thesis": return ["publisher"];
    case "report": return ["publisher"];
    case "conference": return ["journal", "publisher"];
    default: return [];
  }
}

function hasValue(paper, field) {
  if (field === "authors") return list(paper.authors).length > 0;
  return clean(paper[field]) !== "";
}

export function validateCitationMetadata(paper = {}) {
  const type = PUBLICATION_TYPES.has(paper.publicationType) ? paper.publicationType : "article";
  const missingFields = ["title", "authors", "year", ...requiredFields(type)]
    .filter((field, index, fields) => !hasValue(paper, field) && fields.indexOf(field) === index);
  const requestedStatus = paper.citationStatus || paper.status;
  return {
    status: requestedStatus === "unverified" ? "unverified" : (missingFields.length ? "incomplete" : "verified"),
    missingFields
  };
}

function authorText(paper) {
  const authors = list(paper.authors).map(clean);
  return authors.length ? authors.join(", ") : clean(paper.title) || "Untitled";
}

function typeCode(type) {
  return { article: "J", book: "M", chapter: "C", thesis: "D", report: "R", conference: "C", other: "Z" }[type] || "J";
}

export function formatGbt7714(paper = {}) {
  const type = PUBLICATION_TYPES.has(paper.publicationType) ? paper.publicationType : "article";
  const authors = list(paper.authors);
  const parts = [];
  if (authors.length) parts.push(`${authorText(paper)}.`);
  parts.push(`${clean(paper.title) || "Untitled"} [${typeCode(type)}].`);
  if (clean(paper.journal)) parts.push(`${clean(paper.journal)},`);
  if (clean(paper.publisher) && !clean(paper.journal)) parts.push(`${clean(paper.publisher)},`);
  if (clean(paper.year)) parts.push(`${clean(paper.year)},`);
  const issue = clean(paper.issue);
  const volume = clean(paper.volume);
  const pages = clean(paper.pages);
  if (volume || issue || pages) parts.push(`${volume}${issue ? `(${issue})` : ""}${pages ? `: ${pages}` : ""}.`);
  if (clean(paper.doi)) parts.push(`DOI: ${clean(paper.doi)}.`);
  return parts.join(" ").replace(/\s+,/g, ",").replace(/\s+\./g, ".");
}

function apaAuthors(paper) {
  const authors = list(paper.authors).map(clean);
  if (!authors.length) return "";
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
  return `${authors.slice(0, -1).join(", ")}, & ${authors.at(-1)}`;
}

export function formatApa7(paper = {}) {
  const authors = apaAuthors(paper);
  const title = clean(paper.title) || "Untitled";
  const year = yearText(paper);
  const head = authors ? `${authors} (${year}). ${title}.` : `${title} (${year}).`;
  const container = clean(paper.journal);
  const journal = container ? ` ${container}${clean(paper.volume) ? `, ${clean(paper.volume)}` : ""}${clean(paper.issue) ? `(${clean(paper.issue)})` : ""}${clean(paper.pages) ? `, ${clean(paper.pages)}` : ""}.` : "";
  const publisher = clean(paper.publisher) && !container ? ` ${clean(paper.publisher)}.` : "";
  const doi = clean(paper.doi) ? ` https://doi.org/${clean(paper.doi)}` : "";
  return `${head}${journal || publisher}${doi}`.trim();
}

function risType(type) {
  return { article: "JOUR", book: "BOOK", chapter: "CHAP", thesis: "THES", report: "RPRT", conference: "CPAPER", other: "GEN" }[type] || "JOUR";
}

function risValue(value) {
  return clean(value).replace(/\|/g, " ");
}

export function exportRis(papers = []) {
  return papers.map((paper) => {
    const type = PUBLICATION_TYPES.has(paper.publicationType) ? paper.publicationType : "article";
    const lines = [`TY  - ${risType(type)}`];
    if (clean(paper.citationKey)) lines.push(`ID  - ${risValue(paper.citationKey)}`);
    for (const author of list(paper.authors)) lines.push(`AU  - ${risValue(author)}`);
    if (clean(paper.title)) lines.push(`TI  - ${risValue(paper.title)}`);
    if (clean(paper.year)) lines.push(`PY  - ${risValue(paper.year)}`);
    if (clean(paper.journal)) lines.push(`JO  - ${risValue(paper.journal)}`);
    if (clean(paper.volume)) lines.push(`VL  - ${risValue(paper.volume)}`);
    if (clean(paper.issue)) lines.push(`IS  - ${risValue(paper.issue)}`);
    const [start, end] = clean(paper.pages).split(/[-–—]/, 2);
    if (start) lines.push(`SP  - ${risValue(start)}`);
    if (end) lines.push(`EP  - ${risValue(end)}`);
    if (clean(paper.publisher)) lines.push(`PB  - ${risValue(paper.publisher)}`);
    if (clean(paper.doi)) lines.push(`DO  - ${risValue(paper.doi)}`);
    lines.push("ER  -");
    return lines.join("\n");
  }).join("\n\n");
}

function cslType(type) {
  return { article: "article-journal", book: "book", chapter: "chapter", thesis: "thesis", report: "report", conference: "paper-conference", other: "article" }[type] || "article-journal";
}

export function exportCslJson(papers = []) {
  const records = papers.map((paper) => {
    const type = PUBLICATION_TYPES.has(paper.publicationType) ? paper.publicationType : "article";
    const record = {
      id: generateCitationKey(paper, []),
      type: cslType(type),
      title: clean(paper.title) || "Untitled"
    };
    const authors = list(paper.authors).map(authorParts).filter(Boolean);
    if (authors.length) record.author = authors;
    if (/^\d{4}$/.test(String(paper.year ?? ""))) record.issued = { "date-parts": [[Number(paper.year)]] };
    for (const [field, key] of [["journal", "container-title"], ["volume", "volume"], ["issue", "issue"], ["pages", "page"], ["publisher", "publisher"], ["doi", "DOI"]]) {
      if (clean(paper[field])) record[key] = clean(paper[field]);
    }
    return record;
  });
  return JSON.stringify(records, null, 2);
}

function inTextAuthor(paper, style) {
  const authors = list(paper.authors).map((author) => authorParts(author)?.family || clean(author));
  if (!authors.length) return clean(paper.title) || "Untitled";
  if (style === "gbt" || style === "gbt7714") {
    const first = clean(list(paper.authors)[0]) || authors[0];
    return `${first}${authors.length > 1 ? "等" : ""}`;
  }
  if (authors.length > 2) return `${authors[0]} et al.`;
  return authors.join(" & ");
}

export function formatInTextCitation(paper = {}, style = "apa") {
  const author = inTextAuthor(paper, String(style).toLowerCase());
  const year = yearText(paper);
  return String(style).toLowerCase() === "gbt" || String(style).toLowerCase() === "gbt7714"
    ? `${author}（${year}）`
    : `(${author}, ${year})`;
}
