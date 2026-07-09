const state = {
  drafts: [],
  papers: [],
  selectedDraft: null
};

const fields = {
  draftId: document.querySelector("#draftId"),
  title: document.querySelector("#titleField"),
  authors: document.querySelector("#authorsField"),
  year: document.querySelector("#yearField"),
  doi: document.querySelector("#doiField"),
  journal: document.querySelector("#journalField"),
  abstract: document.querySelector("#abstractField"),
  keywords: document.querySelector("#keywordsField"),
  themes: document.querySelector("#themesField"),
  regions: document.querySelector("#regionsField"),
  periods: document.querySelector("#periodsField"),
  materials: document.querySelector("#materialsField"),
  methods: document.querySelector("#methodsField"),
  proxies: document.querySelector("#proxiesField"),
  readingStatus: document.querySelector("#readingStatusField"),
  notesResearchQuestion: document.querySelector("#notesResearchQuestionField"),
  notesRegion: document.querySelector("#notesRegionField"),
  notesMaterialsMethods: document.querySelector("#notesMaterialsMethodsField"),
  notesChronology: document.querySelector("#notesChronologyField"),
  notesCoreFindings: document.querySelector("#notesCoreFindingsField"),
  notesLimits: document.querySelector("#notesLimitsField"),
  notesQuotePoints: document.querySelector("#notesQuotePointsField"),
  notesPersonal: document.querySelector("#notesPersonalField")
};

function splitList(value) {
  return String(value || "")
    .split(/[;,，；|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value) {
  return Array.isArray(value) ? value.join("; ") : "";
}

function setStatus(text) {
  document.querySelector("#statusText").textContent = text;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  const type = response.headers.get("content-type") || "";
  return type.includes("application/json") ? response.json() : response.text();
}

function chip(label, className = "") {
  return `<span class="chip ${className}">${label}</span>`;
}

function renderDrafts() {
  const container = document.querySelector("#draftList");
  if (state.drafts.length === 0) {
    container.innerHTML = `<div class="empty-state">暂无待确认论文</div>`;
    return;
  }
  container.innerHTML = state.drafts
    .map(
      (draft) => `
        <button class="draft-item" data-draft-id="${draft.id}">
          <h3>${draft.title || draft.originalFilename || "未识别题名"}</h3>
          <div class="meta-line">${draft.doi || "未识别 DOI"}</div>
        </button>
      `
    )
    .join("");
}

function renderPapers() {
  const container = document.querySelector("#paperList");
  document.querySelector("#paperCount").textContent = String(state.papers.length);
  if (state.papers.length === 0) {
    container.innerHTML = `<div class="empty-state">暂无已入库论文</div>`;
    return;
  }
  container.innerHTML = state.papers
    .map((paper) => {
      const chips = [
        ...(paper.themes || []).map((item) => chip(item)),
        ...(paper.regions || []).map((item) => chip(item)),
        ...(paper.periods || []).map((item) => chip(item, "period")),
        ...(paper.methods || []).map((item) => chip(item, "method"))
      ].join("");
      return `
        <article class="paper-item" data-paper-id="${paper.id}">
          <h3>${paper.title || "未命名论文"}</h3>
          <div class="meta-line">${(paper.authors || []).join(", ")} · ${paper.year || ""} · ${paper.journal || ""}</div>
          <div class="chip-row">${chips}</div>
        </article>
      `;
    })
    .join("");
}

function fillFormFromDraft(draft) {
  state.selectedDraft = draft;
  document.querySelector("#detailTitle").textContent = "自动识别结果";
  document.querySelector("#detailMode").textContent = "待确认";
  fields.draftId.value = draft.id;
  fields.title.value = draft.title || "";
  fields.authors.value = joinList(draft.authors);
  fields.year.value = draft.year || "";
  fields.doi.value = draft.doi || "";
  fields.journal.value = draft.journal || "";
  fields.abstract.value = draft.abstract || "";
  fields.keywords.value = joinList([...(draft.authorKeywords || []), ...(draft.suggestedKeywords || [])]);
  fields.themes.value = joinList(draft.classification?.themes);
  fields.regions.value = joinList(draft.classification?.regions);
  fields.periods.value = joinList(draft.classification?.periods);
  fields.materials.value = joinList(draft.classification?.materials);
  fields.methods.value = joinList(draft.classification?.methods);
  fields.proxies.value = joinList(draft.classification?.proxies);
  fields.readingStatus.value = "to-read";
  for (const key of [
    "notesResearchQuestion",
    "notesRegion",
    "notesMaterialsMethods",
    "notesChronology",
    "notesCoreFindings",
    "notesLimits",
    "notesQuotePoints",
    "notesPersonal"
  ]) {
    fields[key].value = "";
  }
  renderEvidence(draft);
}

function renderEvidence(draft) {
  const box = document.querySelector("#evidenceBox");
  const lines = [];
  for (const [dimension, values] of Object.entries(draft.evidence || {})) {
    for (const [label, evidence] of Object.entries(values || {})) {
      const confidence = draft.confidence?.[dimension]?.[label];
      const percent = confidence ? `${Math.round(confidence * 100)}%` : "";
      lines.push(`${dimension}: ${label} ${percent} [${(evidence || []).join(", ")}]`);
    }
  }
  box.textContent = lines.length ? lines.join("\n") : "暂无匹配证据";
}

function fillFormFromPaper(paper) {
  state.selectedDraft = null;
  document.querySelector("#detailTitle").textContent = "论文详情";
  document.querySelector("#detailMode").textContent = "已入库";
  fields.draftId.value = "";
  fields.title.value = paper.title || "";
  fields.authors.value = joinList(paper.authors);
  fields.year.value = paper.year || "";
  fields.doi.value = paper.doi || "";
  fields.journal.value = paper.journal || "";
  fields.abstract.value = paper.abstract || "";
  fields.keywords.value = joinList(paper.keywords);
  fields.themes.value = joinList(paper.themes);
  fields.regions.value = joinList(paper.regions);
  fields.periods.value = joinList(paper.periods);
  fields.materials.value = joinList(paper.materials);
  fields.methods.value = joinList(paper.methods);
  fields.proxies.value = joinList(paper.proxies);
  fields.readingStatus.value = paper.readingStatus || "to-read";
  fields.notesResearchQuestion.value = paper.notesResearchQuestion || "";
  fields.notesRegion.value = paper.notesRegion || "";
  fields.notesMaterialsMethods.value = paper.notesMaterialsMethods || "";
  fields.notesChronology.value = paper.notesChronology || "";
  fields.notesCoreFindings.value = paper.notesCoreFindings || "";
  fields.notesLimits.value = paper.notesLimits || "";
  fields.notesQuotePoints.value = paper.notesQuotePoints || "";
  fields.notesPersonal.value = paper.notesPersonal || "";
  document.querySelector("#evidenceBox").textContent = "已确认论文";
}

async function loadDrafts() {
  state.drafts = await api("/api/drafts");
  renderDrafts();
}

async function loadPapers() {
  const params = new URLSearchParams();
  const query = document.querySelector("#searchInput").value.trim();
  if (query) params.set("query", query);
  const map = {
    themes: "#filterThemes",
    regions: "#filterRegions",
    periods: "#filterPeriods",
    materials: "#filterMaterials",
    methods: "#filterMethods",
    proxies: "#filterProxies"
  };
  for (const [name, selector] of Object.entries(map)) {
    const value = document.querySelector(selector).value.trim();
    if (value) params.set(name, value);
  }
  state.papers = await api(`/api/papers?${params.toString()}`);
  renderPapers();
}

function formPayload() {
  return {
    title: fields.title.value.trim(),
    authors: splitList(fields.authors.value),
    year: fields.year.value ? Number(fields.year.value) : null,
    doi: fields.doi.value.trim(),
    journal: fields.journal.value.trim(),
    abstract: fields.abstract.value.trim(),
    keywords: splitList(fields.keywords.value),
    themes: splitList(fields.themes.value),
    regions: splitList(fields.regions.value),
    periods: splitList(fields.periods.value),
    materials: splitList(fields.materials.value),
    methods: splitList(fields.methods.value),
    proxies: splitList(fields.proxies.value),
    readingStatus: fields.readingStatus.value,
    notesResearchQuestion: fields.notesResearchQuestion.value.trim(),
    notesRegion: fields.notesRegion.value.trim(),
    notesMaterialsMethods: fields.notesMaterialsMethods.value.trim(),
    notesChronology: fields.notesChronology.value.trim(),
    notesCoreFindings: fields.notesCoreFindings.value.trim(),
    notesLimits: fields.notesLimits.value.trim(),
    notesQuotePoints: fields.notesQuotePoints.value.trim(),
    notesPersonal: fields.notesPersonal.value.trim()
  };
}

document.querySelector("#uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#pdfInput");
  if (!input.files.length) return;
  const body = new FormData();
  for (const file of input.files) body.append("files", file);

  setStatus("正在识别 PDF");
  try {
    await api("/api/uploads", { method: "POST", body });
    input.value = "";
    await loadDrafts();
    setStatus("识别完成，等待确认");
  } catch (error) {
    setStatus(error.message);
  }
});

document.querySelector("#draftList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-draft-id]");
  if (!button) return;
  const draft = state.drafts.find((item) => item.id === Number(button.dataset.draftId));
  if (draft) fillFormFromDraft(draft);
});

document.querySelector("#paperList").addEventListener("click", (event) => {
  const item = event.target.closest("[data-paper-id]");
  if (!item) return;
  const paper = state.papers.find((entry) => entry.id === Number(item.dataset.paperId));
  if (paper) fillFormFromPaper(paper);
});

document.querySelector("#detailForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = fields.draftId.value;
  if (!id) return;
  setStatus("正在确认入库");
  try {
    const paper = await api(`/api/drafts/${id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formPayload())
    });
    await loadDrafts();
    await loadPapers();
    fillFormFromPaper(paper);
    setStatus("已确认入库");
  } catch (error) {
    setStatus(error.message);
  }
});

document.querySelector("#searchButton").addEventListener("click", loadPapers);
document.querySelector("#searchInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadPapers();
});
document.querySelector("#clearFiltersButton").addEventListener("click", async () => {
  for (const selector of [
    "#searchInput",
    "#filterThemes",
    "#filterRegions",
    "#filterPeriods",
    "#filterMaterials",
    "#filterMethods",
    "#filterProxies"
  ]) {
    document.querySelector(selector).value = "";
  }
  await loadPapers();
});

await loadDrafts();
await loadPapers();

