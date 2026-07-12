const PROJECT_STATUSES = new Set(["active", "archived"]);
const PROJECT_STANCES = new Set(["supports", "opposes", "mixed", "background", "unknown"]);
const PROJECT_PAPER_STATUSES = new Set(["queued", "reading", "reviewed"]);

function plainText(value, field, { required = false, maxLength = 20_000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  if (value.length > maxLength) throw new RangeError(`${field} is too long`);
  if (/<\/?[a-z][^>]*>/i.test(value) || value.includes("\0")) {
    throw new TypeError(`${field} must be plain text`);
  }
  return value.trim();
}

function textList(value, field) {
  if (value === undefined || value === null) return "";
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${field} must be an array of strings`);
  }
  return value.map((item) => plainText(item, field, { maxLength: 2_000 })).filter(Boolean).join("; ");
}

export function normalizeProjectInput(input = {}, { partial = false } = {}) {
  const output = {};
  if (!partial || Object.hasOwn(input, "name")) {
    output.name = plainText(input.name, "name", { required: true, maxLength: 200 });
    if (!output.name) throw new TypeError("name is required");
  }
  if (!partial || Object.hasOwn(input, "description")) {
    output.description = plainText(input.description, "description");
  }
  if (!partial || Object.hasOwn(input, "status")) {
    output.status = input.status === undefined || input.status === null || input.status === "" ? "active" : input.status;
    if (!PROJECT_STATUSES.has(output.status)) throw new TypeError("status must be active or archived");
  }
  return output;
}

export function normalizeProjectPaperInput(input = {}, { partial = false } = {}) {
  const output = {};
  if (!partial || Object.hasOwn(input, "priority")) {
    const priority = input.priority === undefined || input.priority === null || input.priority === "" ? 3 : input.priority;
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) throw new TypeError("priority must be an integer from 1 to 5");
    output.priority = priority;
  }
  if (!partial || Object.hasOwn(input, "stance")) {
    output.stance = input.stance === undefined || input.stance === null || input.stance === "" ? "unknown" : input.stance;
    if (!PROJECT_STANCES.has(output.stance)) throw new TypeError("stance is invalid");
  }
  if (!partial || Object.hasOwn(input, "projectStatus")) {
    output.projectStatus = input.projectStatus === undefined || input.projectStatus === null || input.projectStatus === "" ? "queued" : input.projectStatus;
    if (!PROJECT_PAPER_STATUSES.has(output.projectStatus)) throw new TypeError("projectStatus is invalid");
  }
  if (!partial || Object.hasOwn(input, "projectNote")) output.projectNote = plainText(input.projectNote, "projectNote");
  return output;
}

function cardSort(left, right) {
  return (Number(left.pageNumber || 0) - Number(right.pageNumber || 0)) || (Number(left.id || 0) - Number(right.id || 0));
}

function projectPaperSort(left, right) {
  return left.priority - right.priority || String(left.citationKey || "").localeCompare(String(right.citationKey || "")) ||
    String(left.title || "").localeCompare(String(right.title || "")) || left.paperId - right.paperId;
}

export function buildEvidenceRows({ projectPapers = [], papers = [], researchCards = [] } = {}) {
  const paperById = new Map(papers.map((paper) => [Number(paper.id), paper]));
  const cardsByPaper = new Map();
  for (const card of researchCards) {
    if (!cardsByPaper.has(Number(card.paperId))) cardsByPaper.set(Number(card.paperId), []);
    cardsByPaper.get(Number(card.paperId)).push(card);
  }
  for (const cards of cardsByPaper.values()) cards.sort(cardSort);

  const relations = projectPapers
    .map((relation) => ({ ...relation, paperId: Number(relation.paperId) }))
    .filter((relation) => paperById.has(relation.paperId))
    .map((relation) => ({ ...relation, ...paperById.get(relation.paperId) }))
    .sort(projectPaperSort);
  const rows = [];
  for (const relation of relations) {
    const paper = paperById.get(relation.paperId);
    const cards = cardsByPaper.get(relation.paperId) || [null];
    for (const card of cards) {
      rows.push({
        paperId: relation.paperId,
        citationKey: plainText(paper.citationKey, "citationKey"),
        title: plainText(paper.title, "title"),
        authors: textList(paper.authors, "authors"),
        year: paper.year ?? "",
        paperStatus: paper.paperStatus || (paper.deletedAt ? "inactive" : "active"),
        stance: relation.stance,
        projectStatus: relation.projectStatus,
        priority: relation.priority,
        projectNote: plainText(relation.projectNote, "projectNote"),
        classification: {
          regions: textList(paper.regions, "regions"),
          periods: textList(paper.periods, "periods"),
          materials: textList(paper.materials, "materials"),
          methods: textList(paper.methods, "methods")
        },
        card: card ? {
          quote: plainText(card.quoteText, "quote"),
          summary: plainText(card.summary, "summary"),
          evidenceType: plainText(card.evidenceType, "evidenceType"),
          page: card.pageNumber ?? ""
        } : { quote: "", summary: "", evidenceType: "", page: "" }
      });
    }
  }
  return rows;
}

const evidenceColumns = [
  "citationKey", "title", "authors", "year", "paperStatus", "stance", "projectStatus", "priority", "projectNote",
  "regions", "periods", "materials", "methods", "quote", "summary", "evidenceType", "page"
];

function rowValues(row) {
  return [
    row.citationKey, row.title, row.authors, row.year, row.paperStatus, row.stance, row.projectStatus, row.priority,
    row.projectNote, row.classification.regions, row.classification.periods, row.classification.materials,
    row.classification.methods, row.card.quote, row.card.summary, row.card.evidenceType, row.card.page
  ];
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function exportProjectEvidenceCsv(rows = []) {
  return [evidenceColumns.map(csvValue).join(","), ...rows.map((row) => rowValues(row).map(csvValue).join(","))].join("\n") + "\n";
}

function markdownValue(value) {
  return String(value ?? "").replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

export function exportProjectEvidenceMarkdown(rows = []) {
  const headers = ["Citation key", "Title", "Authors", "Year", "Paper status", "Stance", "Project status", "Priority", "Project note", "Regions", "Periods", "Materials", "Methods", "Quote", "Summary", "Evidence type", "Page"];
  const format = (values) => `| ${values.map(markdownValue).join(" | ")} |`;
  return [format(headers), format(headers.map(() => "---")), ...rows.map((row) => format(rowValues(row)))].join("\n") + "\n";
}

export { PROJECT_PAPER_STATUSES, PROJECT_STATUSES, PROJECT_STANCES };
