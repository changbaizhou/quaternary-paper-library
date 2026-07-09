function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function bibtexKey(paper) {
  const firstAuthor = arrayValue(paper.authors)[0] || "paper";
  const nameParts = firstAuthor.split(/\s+/).filter(Boolean);
  const family = (nameParts[0] || firstAuthor).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const firstTitleWord = String(paper.title || "untitled")
    .split(/\s+/)[0]
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
  return `${family || "paper"}${paper.year || "nd"}${firstTitleWord || "paper"}`;
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function exportBibtex(papers) {
  return papers
    .map((paper) => {
      const fields = [
        ["title", paper.title],
        ["author", arrayValue(paper.authors).join(" and ")],
        ["journal", paper.journal],
        ["year", paper.year],
        ["doi", paper.doi],
        ["keywords", arrayValue(paper.keywords).join("; ")]
      ].filter(([, value]) => value);
      return `@article{${bibtexKey(paper)},\n${fields
        .map(([key, value]) => `  ${key} = {${value}}`)
        .join(",\n")}\n}`;
    })
    .join("\n\n");
}

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
