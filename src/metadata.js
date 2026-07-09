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

export async function lookupTitleMetadata(title, { fetchImpl = fetch } = {}) {
  const normalized = String(title || "").trim();
  if (!normalized) return {};

  const googleBooks = await lookupGoogleBooks(normalized, fetchImpl).catch(() => ({}));
  if (googleBooks.title) return googleBooks;

  const openAlex = await lookupOpenAlexByTitle(normalized, fetchImpl).catch(() => ({}));
  if (openAlex.title) return openAlex;
  return {};
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

async function lookupOpenAlexByTitle(title, fetchImpl) {
  const response = await fetchImpl(
    `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=1`,
    { headers: { accept: "application/json" } }
  );
  if (!response.ok) return {};
  const payload = await response.json();
  const work = payload.results?.[0];
  if (!work) return {};
  return {
    title: work.title || "",
    authors: (work.authorships || []).map((item) => item.author?.display_name).filter(Boolean),
    journal: work.primary_location?.source?.display_name || "",
    year: work.publication_year || null,
    abstract: "",
    authorKeywords: (work.keywords || []).map((item) => item.display_name).filter(Boolean)
  };
}

async function lookupGoogleBooks(title, fetchImpl) {
  const response = await fetchImpl(
    `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title)}&maxResults=1`,
    { headers: { accept: "application/json" } }
  );
  if (!response.ok) return {};
  const payload = await response.json();
  const volume = payload.items?.[0]?.volumeInfo;
  if (!volume?.title) return {};
  const yearMatch = String(volume.publishedDate || "").match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return {
    title: volume.title || "",
    authors: volume.authors || [],
    journal: volume.publisher || "",
    year: yearMatch ? Number(yearMatch[1]) : null,
    abstract: stripHtml(volume.description || ""),
    authorKeywords: volume.categories || []
  };
}
