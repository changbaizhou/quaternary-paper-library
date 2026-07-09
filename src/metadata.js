function cleanDoi(doi) {
  return String(doi || "").trim().replace(/^https?:\/\/doi\.org\//i, "");
}

function crossrefAuthors(items = []) {
  return items
    .map((author) => [author.given, author.family].filter(Boolean).join(" "))
    .filter(Boolean);
}

function crossrefYear(message) {
  const parts =
    message?.published?.["date-parts"] ||
    message?.["published-print"]?.["date-parts"] ||
    message?.["published-online"]?.["date-parts"];
  return parts?.[0]?.[0] || null;
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, "").trim();
}

export async function lookupDoiMetadata(doi, { fetchImpl = fetch } = {}) {
  const normalized = cleanDoi(doi);
  if (!normalized) return {};

  const crossref = await lookupCrossref(normalized, fetchImpl).catch(() => ({}));
  if (crossref.title) return crossref;
  return lookupOpenAlex(normalized, fetchImpl).catch(() => ({}));
}

async function lookupCrossref(doi, fetchImpl) {
  const response = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) return {};
  const payload = await response.json();
  const message = payload.message || {};
  return {
    doi,
    title: message.title?.[0] || "",
    authors: crossrefAuthors(message.author),
    journal: message["container-title"]?.[0] || "",
    year: crossrefYear(message),
    abstract: stripHtml(message.abstract || ""),
    authorKeywords: message.subject || []
  };
}

async function lookupOpenAlex(doi, fetchImpl) {
  const response = await fetchImpl(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) return {};
  const payload = await response.json();
  return {
    doi,
    title: payload.title || "",
    authors: (payload.authorships || [])
      .map((item) => item.author?.display_name)
      .filter(Boolean),
    journal: payload.primary_location?.source?.display_name || "",
    year: payload.publication_year || null,
    abstract: "",
    authorKeywords: (payload.keywords || []).map((item) => item.display_name).filter(Boolean)
  };
}

