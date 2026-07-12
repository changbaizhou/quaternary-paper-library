import * as pdfjsLib from "/vendor/pdfjs-dist/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs-dist/build/pdf.worker.mjs";

const HIGH_RESOLUTION_SCALE = 2;
const MAX_CANVAS_SCALE = 3;
const MIN_READER_SCALE = 0.75;
const MAX_READER_SCALE = 2.6;
const AUTO_TRANSLATE_DELAY_MS = 450;
const NOTE_AUTOSAVE_DELAY_MS = 800;
const READING_PROGRESS_AUTOSAVE_DELAY_MS = 200;

const noteFieldNames = [
  "readingStatus",
  "notesResearchQuestion",
  "notesRegion",
  "notesMaterialsMethods",
  "notesChronology",
  "notesCoreFindings",
  "notesLimits",
  "notesQuotePoints",
  "notesPersonal"
];

const state = {
  drafts: [],
  papers: [],
  searchResults: null,
  searchTotal: 0,
  searchLoading: false,
  searchError: "",
  trash: [],
  backups: [],
  duplicateRows: [],
  projects: [],
  projectStatusFilter: "all",
  selectedProject: null,
  projectPapers: [],
  projectEvidenceRows: [],
  projectPaperDialogMode: "papers",
  currentView: "library",
  selectedDraft: null,
  selectedPaper: null,
  selectedPaperIds: new Set(),
  notesDirty: false,
  noteAutosaveTimer: null,
  noteSaveRequestId: 0,
  noteSavePromise: null,
  metadataSavePromise: null,
  draftConfirmPromise: null,
  trashTargetPaper: null,
  trashPaperPromise: null,
  reader: {
    document: null,
    loadingTask: null,
    paperId: null,
    pageNumber: 1,
    pageCount: 0,
    scale: 1,
    bookmarkPage: null,
    lastReadPage: null,
    progressSaveTimer: null,
    pendingProgress: null,
    progressSavePromise: null,
    renderToken: 0,
    sourceUrl: "",
    observer: null,
    pageShells: new Map(),
    renderedPages: new Set(),
    renderingPages: new Set(),
    autoTranslateTimer: null,
    lastTranslatedSelection: "",
    pendingTranslationSelection: "",
    translationRequestId: 0,
    annotations: [],
    researchCards: [],
    selection: null,
    annotationResolutions: new Map(),
    editingCardId: null
  },
  researchResults: new Map()
};

const fields = {
  draftId: document.querySelector("#draftId"),
  title: document.querySelector("#titleField"),
  authors: document.querySelector("#authorsField"),
  year: document.querySelector("#yearField"),
  doi: document.querySelector("#doiField"),
  journal: document.querySelector("#journalField"),
  volume: document.querySelector("#volumeField"),
  issue: document.querySelector("#issueField"),
  pages: document.querySelector("#pagesField"),
  publisher: document.querySelector("#publisherField"),
  publicationType: document.querySelector("#publicationTypeField"),
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

const saveElements = {
  button: document.querySelector("#savePaperButton"),
  status: document.querySelector("#paperSaveStatus")
};

const trashElements = {
  button: document.querySelector("#trashPaperButton"),
  dialog: document.querySelector("#trashPaperDialog"),
  title: document.querySelector("#trashPaperDialogTitle"),
  message: document.querySelector("#trashPaperDialogMessage"),
  cancel: document.querySelector("#trashPaperDialogCancel"),
  confirm: document.querySelector("#trashPaperDialogConfirm")
};

const citationElements = {
  key: document.querySelector("#citationKeyField"),
  status: document.querySelector("#citationStatusField"),
  missing: document.querySelector("#citationMissingFields"),
  verify: document.querySelector("#verifyCitationButton"),
  regenerate: document.querySelector("#regenerateCitationButton"),
  copyInText: document.querySelector("#copyInTextCitationButton"),
  copyBibliography: document.querySelector("#copyBibliographyButton"),
  exportMenu: document.querySelector("#citationExportMenu"),
  exportFormat: document.querySelector("#citationExportFormat"),
  exportSelected: document.querySelector("#exportSelectedCitations"),
  selectionStatus: document.querySelector("#citationSelectionStatus")
};

const detailEditableControls = Array.from(
  document.querySelector("#detailForm").querySelectorAll("input:not([type='hidden']), select, textarea")
);

const readerElements = {
  listView: document.querySelector("#paperListView"),
  readerView: document.querySelector("#readerView"),
  title: document.querySelector("#readerTitle"),
  meta: document.querySelector("#readerMeta"),
  viewer: document.querySelector("#pdfViewer"),
  openButton: document.querySelector("#openPdfButton"),
  pageNumberInput: document.querySelector("#pageNumberInput"),
  pageCountText: document.querySelector("#pageCountText"),
  zoomText: document.querySelector("#zoomText"),
  previousButton: document.querySelector("#previousPageButton"),
  nextButton: document.querySelector("#nextPageButton"),
  setBookmarkButton: document.querySelector("#setBookmarkButton"),
  goBookmarkButton: document.querySelector("#goBookmarkButton"),
  bookmarkStatusText: document.querySelector("#bookmarkStatusText"),
  translateSelectionButton: document.querySelector("#translateSelectionButton"),
  translationPanel: document.querySelector("#translationPanel"),
  translationStatusText: document.querySelector("#translationStatusText"),
  translationResultText: document.querySelector("#translationResultText"),
  selectionToolbar: document.querySelector("#annotationSelectionToolbar"),
  saveHighlightButton: document.querySelector("#saveHighlightButton"),
  saveNoteButton: document.querySelector("#saveNoteButton"),
  translateAnnotationButton: document.querySelector("#translateAnnotationButton"),
  saveQuoteButton: document.querySelector("#saveQuoteButton"),
  annotationSidebar: document.querySelector("#annotationSidebar"),
  annotationCount: document.querySelector("#annotationCount"),
  annotationList: document.querySelector("#annotationList"),
  annotationKindFilter: document.querySelector("#annotationKindFilter"),
  annotationColorFilter: document.querySelector("#annotationColorFilter"),
  researchCardCount: document.querySelector("#researchCardCount"),
  researchCardList: document.querySelector("#researchCardList"),
  researchCardEditor: document.querySelector("#researchCardEditor"),
  cardSummaryField: document.querySelector("#cardSummaryField"),
  cardInterpretationField: document.querySelector("#cardInterpretationField"),
  cardThemesField: document.querySelector("#cardThemesField"),
  cardEvidenceTypeField: document.querySelector("#cardEvidenceTypeField"),
  saveResearchCardButton: document.querySelector("#saveResearchCardButton"),
  cancelResearchCardButton: document.querySelector("#cancelResearchCardButton")
};

const workspaceElements = {
  library: document.querySelector("#paperListView"),
  paperListPanel: document.querySelector(".paper-list-panel"),
  trash: document.querySelector("#trashView"),
  maintenance: document.querySelector("#maintenanceView"),
  projects: document.querySelector("#projectsView"),
  projectList: document.querySelector("#projectList"),
  projectQueueList: document.querySelector("#projectQueueList"),
  projectQueueTitle: document.querySelector("#projectQueueTitle"),
  projectQueueMeta: document.querySelector("#projectQueueMeta"),
  projectEvidencePanel: document.querySelector("#projectEvidencePanel"),
  projectEvidence: document.querySelector("#projectEvidence"),
  projectEvidenceMeta: document.querySelector("#projectEvidenceMeta"),
  trashCount: document.querySelector("#trashCount"),
  trashList: document.querySelector("#trashList"),
  duplicateCandidates: document.querySelector("#duplicateCandidates"),
  backupList: document.querySelector("#backupList"),
  maintenanceProgress: document.querySelector("#maintenanceProgress")
};

const researchElements = {
  library: {
    question: document.querySelector("#researchQuestion"),
    project: document.querySelector("#researchProjectScope"),
    papers: document.querySelector("#researchPaperScope"),
    ask: document.querySelector("#askResearchButton"),
    status: document.querySelector("#researchStatus"),
    answer: document.querySelector("#researchAnswer"),
    history: document.querySelector("#researchHistory")
  },
  project: {
    question: document.querySelector("#projectResearchQuestion"),
    project: null,
    papers: document.querySelector("#projectResearchPaperScope"),
    ask: document.querySelector("#projectAskResearchButton"),
    status: document.querySelector("#projectResearchStatus"),
    answer: document.querySelector("#projectResearchAnswer"),
    history: document.querySelector("#projectResearchHistory")
  }
};

const viewButtons = {
  library: document.querySelector("#libraryViewButton"),
  projects: document.querySelector("#projectsViewButton"),
  trash: document.querySelector("#trashViewButton"),
  maintenance: document.querySelector("#maintenanceViewButton")
};

const DUPLICATE_REASON_LABELS = {
  sha256: "文件完全相同",
  doi: "DOI 相同",
  title: "题名高度相似"
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

function normalizeReaderPage(value) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : null;
}

function patchPaperInState(updatedPaper) {
  if (!updatedPaper?.id) return;
  state.papers = state.papers.map((paper) => (paper.id === updatedPaper.id ? updatedPaper : paper));
  if (state.selectedPaper?.id === updatedPaper.id) state.selectedPaper = updatedPaper;
}

function nodeIsInsideReader(node) {
  if (!node) return false;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element && readerElements.viewer.contains(element));
}

function getSelectedReaderText() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return "";
  if (!nodeIsInsideReader(selection.anchorNode) || !nodeIsInsideReader(selection.focusNode)) return "";
  return selection.toString().replace(/\s+/g, " ").trim();
}

function selectedPageWrapper(selection = window.getSelection()) {
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  return node?.closest?.(".pdf-page-wrapper") || null;
}

function buildTextSelectorFromSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !getSelectedReaderText()) return null;
  if (!nodeIsInsideReader(selection.anchorNode) || !nodeIsInsideReader(selection.focusNode)) return null;
  const range = selection.getRangeAt(0);
  const pageWrapper = selectedPageWrapper(selection);
  const quote = range.toString();
  const selector = {
    quote,
    prefix: "",
    suffix: "",
    positionVerified: false
  };
  if (!pageWrapper) return { pageNumber: null, quote, selector };

  const textLayer = pageWrapper.querySelector(".text-layer");
  if (!textLayer) return { pageNumber: Number(pageWrapper.dataset.pageNumber), quote, selector };
  const pageText = textLayer.textContent || "";
  try {
    const before = range.cloneRange();
    before.selectNodeContents(textLayer);
    before.setEnd(range.startContainer, range.startOffset);
    const after = range.cloneRange();
    after.selectNodeContents(textLayer);
    after.setEnd(range.endContainer, range.endOffset);
    const start = before.toString().length;
    const end = after.toString().length;
    selector.start = start;
    selector.end = end;
    selector.prefix = pageText.slice(Math.max(0, start - 32), start);
    selector.suffix = pageText.slice(end, end + 32);
    selector.positionVerified = pageText.slice(start, end) === quote;
  } catch {
    selector.positionVerified = false;
  }
  return { pageNumber: Number(pageWrapper.dataset.pageNumber), quote, selector };
}

function positionSelectionToolbar() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !state.reader.selection) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  readerElements.selectionToolbar.style.left = `${Math.max(8, rect.left)}px`;
  readerElements.selectionToolbar.style.top = `${Math.max(8, rect.top - 44)}px`;
}

function showSelectionToolbar() {
  const snapshot = buildTextSelectorFromSelection();
  if (!snapshot || !snapshot.pageNumber) {
    state.reader.selection = null;
    readerElements.selectionToolbar.hidden = true;
    return;
  }
  state.reader.selection = snapshot;
  readerElements.selectionToolbar.hidden = false;
  positionSelectionToolbar();
}

function hideSelectionToolbar() {
  state.reader.selection = null;
  readerElements.selectionToolbar.hidden = true;
}

function makeActionButton(label, action, dataset = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = label;
  button.dataset.action = action;
  for (const [key, value] of Object.entries(dataset)) button.dataset[key] = String(value);
  return button;
}

function annotationColorValue(color) {
  return {
    yellow: "#d6ab3c",
    green: "#63a975",
    blue: "#5c91c5",
    pink: "#d6819a",
    purple: "#9770b5"
  }[color] || "#d6ab3c";
}

function filteredAnnotations() {
  const kind = readerElements.annotationKindFilter.value;
  const color = readerElements.annotationColorFilter.value;
  return state.reader.annotations.filter((annotation) =>
    (!kind || annotation.kind === kind) && (!color || annotation.color === color)
  );
}

function renderAnnotations() {
  const annotations = filteredAnnotations();
  readerElements.annotationCount.textContent = String(state.reader.annotations.length);
  readerElements.annotationList.replaceChildren();
  if (!annotations.length) {
    const empty = document.createElement("div");
    empty.className = "annotation-meta";
    empty.textContent = "本篇暂无标注";
    readerElements.annotationList.append(empty);
  }
  for (const annotation of annotations) {
    const item = document.createElement("article");
    item.className = "annotation-item";
    item.style.setProperty("--annotation-color", annotationColorValue(annotation.color));
    const heading = document.createElement("div");
    heading.className = "annotation-card-heading";
    const title = document.createElement("strong");
    title.textContent = annotation.kind === "highlight" ? "高亮" : annotation.kind === "note" ? "批注" : "摘录";
    const page = document.createElement("span");
    page.className = "annotation-meta";
    page.textContent = `第 ${annotation.pageNumber} 页`;
    heading.append(title, page);
    const quote = document.createElement("div");
    quote.className = "annotation-quote";
    quote.textContent = annotation.quoteText;
    const meta = document.createElement("div");
    meta.className = "annotation-meta";
    meta.textContent = state.reader.annotationResolutions.get(annotation.id) === false
      ? "待重新定位"
      : annotation.comment || "";
    const actions = document.createElement("div");
    actions.className = "annotation-actions";
    actions.append(
      makeActionButton("跳页", "jump-annotation", { annotationId: annotation.id }),
      makeActionButton("编辑", "edit-annotation", { annotationId: annotation.id }),
      makeActionButton("删除", "delete-annotation", { annotationId: annotation.id })
    );
    item.append(heading, quote, meta, actions);
    readerElements.annotationList.append(item);
  }
}

function renderResearchCards() {
  readerElements.researchCardCount.textContent = String(state.reader.researchCards.length);
  readerElements.researchCardList.replaceChildren();
  if (!state.reader.researchCards.length) {
    const empty = document.createElement("div");
    empty.className = "research-card-meta";
    empty.textContent = "暂无研究卡片";
    readerElements.researchCardList.append(empty);
  }
  for (const card of state.reader.researchCards) {
    const item = document.createElement("article");
    item.className = "research-card-item";
    const heading = document.createElement("div");
    heading.className = "annotation-card-heading";
    const title = document.createElement("strong");
    title.textContent = card.evidenceType;
    const page = document.createElement("span");
    page.className = "research-card-meta";
    page.textContent = `第 ${card.pageNumber} 页`;
    heading.append(title, page);
    const quote = document.createElement("div");
    quote.className = "research-card-quote";
    quote.textContent = card.quoteText;
    const summary = document.createElement("div");
    summary.className = "research-card-meta";
    summary.textContent = card.summary || "未填写摘要";
    const actions = document.createElement("div");
    actions.className = "research-card-actions";
    actions.append(
      makeActionButton("跳页", "jump-card", { cardId: card.id }),
      makeActionButton("编辑", "edit-card", { cardId: card.id }),
      makeActionButton("删除", "delete-card", { cardId: card.id })
    );
    item.append(heading, quote, summary, actions);
    readerElements.researchCardList.append(item);
  }
}

async function loadReaderRecords() {
  if (!state.reader.paperId) return;
  const paperId = state.reader.paperId;
  const [annotations, researchCards] = await Promise.all([
    api(`/api/papers/${paperId}/annotations`),
    api(`/api/research-cards?paperId=${paperId}`)
  ]);
  if (state.reader.paperId !== paperId) return;
  state.reader.annotations = annotations;
  state.reader.researchCards = researchCards;
  state.reader.annotationResolutions = new Map();
  renderAnnotations();
  renderResearchCards();
}

function findTextRange(textLayer, quote, selector = {}) {
  const text = textLayer.textContent || "";
  let start = selector.positionVerified && Number.isInteger(selector.start)
    && text.slice(selector.start, selector.end) === quote
    ? selector.start
    : text.indexOf(quote);
  if (start < 0) return null;
  const end = start + quote.length;
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  let offset = 0;
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: offset, end: offset + node.nodeValue.length });
    offset += node.nodeValue.length;
  }
  const boundary = (position) => {
    const target = nodes.find((entry) => position >= entry.start && position <= entry.end);
    if (!target) return null;
    return { node: target.node, offset: position - target.start };
  };
  const rangeStart = boundary(start);
  const rangeEnd = boundary(end);
  if (!rangeStart || !rangeEnd) return null;
  const range = document.createRange();
  range.setStart(rangeStart.node, rangeStart.offset);
  range.setEnd(rangeEnd.node, rangeEnd.offset);
  return range;
}

function restoreAnnotationOverlays(pageNumber, shell) {
  const pageAnnotations = state.reader.annotations.filter((annotation) =>
    annotation.pageNumber === pageNumber && annotation.kind !== "note"
  );
  const textLayer = shell.querySelector(".text-layer");
  if (!textLayer) return;
  for (const annotation of pageAnnotations) {
    const range = findTextRange(textLayer, annotation.quoteText, annotation.textSelector || {});
    if (!range) {
      state.reader.annotationResolutions.set(annotation.id, false);
      continue;
    }
    state.reader.annotationResolutions.set(annotation.id, true);
    for (const rect of range.getClientRects()) {
      const pageRect = shell.getBoundingClientRect();
      const overlay = document.createElement("span");
      overlay.className = "annotation-overlay";
      overlay.style.left = `${rect.left - pageRect.left}px`;
      overlay.style.top = `${rect.top - pageRect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      overlay.style.background = `${annotationColorValue(annotation.color)}66`;
      shell.append(overlay);
    }
  }
  renderAnnotations();
}

function currentSelectionTranslation() {
  const selectedText = getSelectedReaderText();
  return selectedText && selectedText === state.reader.lastTranslatedSelection
    ? readerElements.translationResultText.textContent.trim()
    : "";
}

async function saveSelectedAnnotation(kind) {
  const selection = state.reader.selection || buildTextSelectorFromSelection();
  if (!selection || !selection.pageNumber || !state.reader.paperId) return;
  const comment = kind === "note" ? window.prompt("请输入批注", "") : "";
  if (kind === "note" && comment === null) return;
  try {
    const annotation = await api(`/api/papers/${state.reader.paperId}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageNumber: selection.pageNumber,
        kind,
        quoteText: selection.quote,
        translatedText: currentSelectionTranslation(),
        comment: comment || "",
        color: "yellow",
        textSelector: selection.selector
      })
    });
    if (kind === "quote") {
      await api("/api/research-cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          annotationId: annotation.id,
          paperId: state.reader.paperId,
          pageNumber: annotation.pageNumber,
          quoteText: annotation.quoteText,
          translatedText: annotation.translatedText,
          summary: "",
          personalInterpretation: "",
          themes: [],
          evidenceType: "uncertain"
        })
      });
    }
    await loadReaderRecords();
    if (kind === "quote") {
      const card = state.reader.researchCards.find((entry) => entry.annotationId === annotation.id);
      if (card) beginResearchCardEdit(card);
    }
    hideSelectionToolbar();
    window.getSelection()?.removeAllRanges();
    setStatus(kind === "quote" ? "摘录和研究卡片已保存" : "标注已保存");
  } catch (error) {
    setStatus(error.message);
  }
}

function beginResearchCardEdit(card) {
  state.reader.editingCardId = card.id;
  readerElements.cardSummaryField.value = card.summary || "";
  readerElements.cardInterpretationField.value = card.personalInterpretation || "";
  readerElements.cardThemesField.value = (card.themes || []).join(", ");
  readerElements.cardEvidenceTypeField.value = card.evidenceType || "uncertain";
  readerElements.researchCardEditor.hidden = false;
}

function cancelResearchCardEdit() {
  state.reader.editingCardId = null;
  readerElements.researchCardEditor.hidden = true;
}

async function saveResearchCardEdit(event) {
  event.preventDefault();
  const card = state.reader.researchCards.find((entry) => entry.id === state.reader.editingCardId);
  if (!card) return;
  try {
    await api(`/api/research-cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: card.version,
        summary: readerElements.cardSummaryField.value,
        personalInterpretation: readerElements.cardInterpretationField.value,
        themes: readerElements.cardThemesField.value.split(",").map((theme) => theme.trim()).filter(Boolean),
        evidenceType: readerElements.cardEvidenceTypeField.value
      })
    });
    cancelResearchCardEdit();
    await loadReaderRecords();
    setStatus("研究卡片已保存");
  } catch (error) {
    setStatus(error.message);
  }
}

async function editAnnotation(annotation) {
  const comment = window.prompt("编辑批注", annotation.comment || "");
  if (comment === null) return;
  try {
    await api(`/api/annotations/${annotation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: annotation.version, comment })
    });
    await loadReaderRecords();
  } catch (error) {
    setStatus(error.message);
  }
}

async function deleteAnnotation(annotation) {
  if (!await confirmAction("删除标注", "标注会被删除，关联研究卡片将保留。", "删除")) return;
  try {
    await api(`/api/annotations/${annotation.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    await loadReaderRecords();
  } catch (error) {
    setStatus(error.message);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const type = response.headers.get("content-type") || "";
  return type.includes("application/json") ? response.json() : response.text();
}

async function apiWithTimeout(path, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await api(path, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function appendResearchCitation(container, citation, action = "open-research-citation", researchKey = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "research-citation-link";
  button.dataset.action = action;
  button.dataset.citationId = citation.citationId || "";
  if (researchKey) button.dataset.researchKey = researchKey;
  button.textContent = `${citation.title || "未命名论文"}，第${citation.pageNumber}页`;
  container.append(button);
}

function researchResultKey(panelName, id = "current") {
  return `${panelName}:${id}`;
}

function renderResearchResult(panelName, result, container = researchElements[panelName].answer) {
  const key = researchResultKey(panelName);
  state.researchResults.set(key, result);
  container.replaceChildren();
  if (!result) return;
  const heading = document.createElement("div");
  heading.className = "research-answer-heading";
  const label = document.createElement("strong");
  label.textContent = "AI 生成";
  heading.append(label);
  const answer = document.createElement("p");
  answer.className = "research-answer-text";
  answer.textContent = result.answer || "";
  container.append(heading, answer);
  const citations = document.createElement("div");
  citations.className = "research-citations";
  for (const citation of result.citations || []) {
    const row = document.createElement("div");
    row.className = "research-citation-row";
    appendResearchCitation(row, citation);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "secondary compact-action";
    save.dataset.action = "save-research-card";
    save.dataset.citationId = citation.citationId || "";
    save.textContent = "保存为研究卡片";
    row.append(save);
    citations.append(row);
  }
  if (citations.childElementCount) container.append(citations);
}

function renderResearchHistory(panelName, records) {
  const container = researchElements[panelName].history;
  container.replaceChildren();
  if (!records?.length) {
    const empty = document.createElement("div");
    empty.className = "research-history-empty";
    empty.textContent = "暂无历史问答";
    container.append(empty);
    return;
  }
  for (const record of records) {
    const recordKey = researchResultKey(panelName, `history-${record.id}`);
    state.researchResults.set(recordKey, record);
    const item = document.createElement("article");
    item.className = "research-history-item";
    const question = document.createElement("strong");
    question.textContent = record.question || "";
    const answer = document.createElement("p");
    answer.textContent = record.answer || "";
    const citationList = document.createElement("div");
    citationList.className = "research-citations";
    for (const citation of record.citations || []) appendResearchCitation(citationList, citation, "open-research-citation", recordKey);
    item.append(question, answer, citationList);
    container.append(item);
  }
}

function fillResearchSelect(select, entries, emptyLabel = "全部") {
  select.replaceChildren();
  if (select.multiple) {
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = String(entry.id);
      option.textContent = entry.title || entry.name || String(entry.id);
      select.append(option);
    }
    return;
  }
  const all = document.createElement("option");
  all.value = "";
  all.textContent = emptyLabel;
  select.append(all);
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = String(entry.id);
    option.textContent = entry.title || entry.name || String(entry.id);
    select.append(option);
  }
}

function renderResearchScopes() {
  fillResearchSelect(researchElements.library.project, state.projects, "全部项目");
  fillResearchSelect(researchElements.library.papers, state.papers);
  const projectEntries = state.projectPapers.filter((paper) => paper.paperStatus === "active").map((paper) => ({ id: paper.paperId, title: paper.title }));
  fillResearchSelect(researchElements.project.papers, projectEntries);
  researchElements.project.ask.disabled = !state.selectedProject;
}

async function loadResearchHistory(panelName, projectId = "") {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}&limit=20` : "?limit=20";
  try {
    renderResearchHistory(panelName, await api(`/api/research/answers${query}`));
  } catch (error) {
    researchElements[panelName].history.replaceChildren();
    researchElements[panelName].status.textContent = error.message;
  }
}

async function askResearch(panelName) {
  const elements = researchElements[panelName];
  const question = elements.question.value.trim();
  if (!question) {
    elements.status.textContent = "请输入问题";
    return;
  }
  const projectId = panelName === "project" ? state.selectedProject?.id : (elements.project.value || undefined);
  const paperIds = [...elements.papers.selectedOptions].map((option) => Number(option.value)).filter(Boolean);
  elements.ask.disabled = true;
  elements.status.textContent = "正在检索论文页并生成回答…";
  try {
    const result = await api("/api/research/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, ...(projectId ? { projectId: Number(projectId) } : {}), ...(paperIds.length ? { paperIds } : {}) })
    });
    renderResearchResult(panelName, result);
    elements.status.textContent = "回答已生成";
    await loadResearchHistory(panelName, projectId || "");
  } catch (error) {
    elements.answer.replaceChildren();
    elements.status.textContent = error.message;
  } finally {
    elements.ask.disabled = panelName === "project" && !state.selectedProject;
  }
}

async function openResearchCitation(panelName, citationId, resultKey = researchResultKey(panelName)) {
  const result = state.researchResults.get(resultKey);
  const citation = (result?.citations || []).find((entry) => entry.citationId === citationId);
  if (!citation) return;
  const paper = (await loadAllPapers()).find((entry) => entry.id === citation.paperId);
  if (!paper) return;
  fillFormFromPaper(paper);
  await openReader(paper, { targetPage: citation.pageNumber });
}

async function saveResearchAnswerAsCard(panelName, citationId) {
  const result = state.researchResults.get(researchResultKey(panelName));
  const citation = (result?.citations || []).find((entry) => entry.citationId === citationId);
  if (!citation || !result?.answer) return;
  try {
    await api("/api/research-cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paperId: citation.paperId,
        pageNumber: citation.pageNumber,
        quoteText: result.answer,
        summary: result.answer,
        personalInterpretation: "",
        themes: [],
        evidenceType: "uncertain"
      })
    });
    researchElements[panelName].status.textContent = "研究卡片已保存";
  } catch (error) {
    researchElements[panelName].status.textContent = error.message;
  }
}

function handleResearchPanelClick(panelName, event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "open-research-citation") void openResearchCitation(panelName, button.dataset.citationId, button.dataset.researchKey || researchResultKey(panelName));
  if (button.dataset.action === "save-research-card") void saveResearchAnswerAsCard(panelName, button.dataset.citationId);
}

function formatDateTime(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes || 0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function confirmAction(title, message, confirmLabel = "确认") {
  const dialog = document.querySelector("#confirmDialog");
  if (!dialog?.showModal) return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  document.querySelector("#confirmDialogTitle").textContent = title;
  document.querySelector("#confirmDialogMessage").textContent = message;
  document.querySelector("#confirmDialogConfirm").textContent = confirmLabel;
  return new Promise((resolve) => {
    dialog.onclose = () => {
      dialog.onclose = null;
      resolve(dialog.returnValue === "confirm");
    };
    dialog.showModal();
  });
}

function captureTrashTarget(paper) {
  return Object.freeze({ id: paper.id, title: paper.title || "未命名论文" });
}

function buildTrashDeleteRequest(target) {
  return { path: `/api/papers/${target.id}`, options: { method: "DELETE" } };
}

function isTrashTargetSelected(selectedPaper, target) {
  return selectedPaper?.id === target.id;
}

function confirmTrashPaper(paper) {
  const message = `确定将《${paper.title}》移入回收站吗？原始 PDF 会保留。`;
  if (!trashElements.dialog?.showModal) return Promise.resolve(window.confirm(message));
  trashElements.title.textContent = "移入回收站";
  trashElements.message.textContent = message;
  return new Promise((resolve) => {
    trashElements.dialog.onclose = () => {
      trashElements.dialog.onclose = null;
      resolve(trashElements.dialog.returnValue === "confirm");
    };
    trashElements.dialog.showModal();
  });
}

function setMaintenanceBusy(busy, message = "") {
  workspaceElements.maintenance.classList.toggle("is-busy", busy);
  workspaceElements.maintenanceProgress.hidden = !busy;
  workspaceElements.maintenanceProgress.textContent = message;
  for (const button of workspaceElements.maintenance.querySelectorAll("button")) button.disabled = busy;
}

function showWorkspaceView(view) {
  state.currentView = view;
  for (const [name, element] of Object.entries({
    library: workspaceElements.library,
    projects: workspaceElements.projects,
    trash: workspaceElements.trash,
    maintenance: workspaceElements.maintenance
  })) {
    element.hidden = name !== view;
  }
  readerElements.readerView.hidden = true;
  readerElements.listView.hidden = view !== "library";
  workspaceElements.paperListPanel.hidden = view === "projects";
  workspaceElements.projectEvidencePanel.hidden = view !== "projects";
  document.querySelector("#detailForm").hidden = view === "projects";
  document.querySelector("#detailTitle").textContent = view === "projects" ? "项目证据" : "详情";
  document.querySelector("#detailMode").textContent = view === "projects" ? "批量证据" : "未选择";
  for (const [name, button] of Object.entries(viewButtons)) {
    const active = name === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function duplicateReasonLabel(reason) {
  return DUPLICATE_REASON_LABELS[reason] || "疑似重复";
}

function setPaperSaveState(text, stateClass) {
  saveElements.status.textContent = text;
  saveElements.status.className = `paper-save-status ${stateClass}`;
}

function clearNoteAutosave({ resetDirty = false } = {}) {
  if (state.noteAutosaveTimer) clearTimeout(state.noteAutosaveTimer);
  state.noteAutosaveTimer = null;
  state.noteSaveRequestId += 1;
  if (resetDirty) state.notesDirty = false;
}

function clearReadingProgressQueue() {
  if (state.reader.progressSaveTimer) clearTimeout(state.reader.progressSaveTimer);
  state.reader.progressSaveTimer = null;
  state.reader.pendingProgress = null;
}

function requeueReadingProgress(sentProgress, pendingProgress = {}) {
  return { ...sentProgress, ...(pendingProgress || {}) };
}

function setDetailFormLocked(locked) {
  for (const control of detailEditableControls) control.disabled = locked;
  saveElements.button.disabled = locked;
  updateTrashPaperButton();
}

function updateTrashPaperButton() {
  trashElements.button.disabled = Boolean(
    !state.selectedPaper ||
    fields.draftId.value ||
    state.metadataSavePromise ||
    state.noteSavePromise ||
    state.trashTargetPaper ||
    state.trashPaperPromise
  );
  const addToProjectButton = document.querySelector("#paperAddToProjectButton");
  if (addToProjectButton) addToProjectButton.disabled = !state.selectedPaper || Boolean(fields.draftId.value);
}

function chip(label, className = "") {
  return `<span class="chip ${className}">${escapeHtml(label)}</span>`;
}

function appendSafeHighlightedText(container, value, terms = []) {
  const text = String(value || "");
  const normalized = text.toLocaleLowerCase();
  const needles = [...new Set((terms || []).map((term) => String(term || "").trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  let cursor = 0;
  while (cursor < text.length) {
    let match = null;
    for (const needle of needles) {
      const index = normalized.indexOf(needle.toLocaleLowerCase(), cursor);
      if (index < 0 || (match && index >= match.index)) continue;
      match = { index, needle };
    }
    if (!match) {
      container.append(document.createTextNode(text.slice(cursor)));
      break;
    }
    if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(match.index, match.index + match.needle.length);
    container.append(mark);
    cursor = match.index + match.needle.length;
  }
}

function renderSearchResults() {
  const container = document.querySelector("#paperList");
  const status = document.querySelector("#searchResultStatus");
  document.querySelector("#paperCount").textContent = String(state.searchTotal);
  status.hidden = false;
  status.className = "search-result-status";
  if (state.searchLoading) {
    status.textContent = "正在检索…";
    container.replaceChildren();
    return;
  }
  if (state.searchError) {
    status.classList.add("is-error");
    status.textContent = `检索失败：${state.searchError}`;
    container.replaceChildren();
    return;
  }
  if (!state.searchResults?.length) {
    status.textContent = "没有找到匹配结果";
    container.replaceChildren();
    return;
  }
  status.textContent = `找到 ${state.searchTotal} 条命中`;
  container.replaceChildren(...state.searchResults.map((hit) => {
    const item = document.createElement("article");
    item.className = "paper-item search-result-item";
    item.dataset.paperId = String(hit.paperId);
    item.dataset.searchHit = "true";
    item.dataset.matchScope = hit.matchScope;
    if (hit.pageNumber) item.dataset.targetPage = String(hit.pageNumber);

    const main = document.createElement("div");
    main.className = "paper-card-main";
    const title = document.createElement("h3");
    title.className = "paper-title";
    title.textContent = hit.title || "未命名论文";
    const meta = document.createElement("div");
    meta.className = "paper-meta";
    meta.textContent = [(hit.authors || []).join(", "), hit.year].filter(Boolean).join(" · ");
    main.append(title, meta);

    const scope = document.createElement("div");
    scope.className = "search-hit-meta";
    scope.textContent = hit.matchScope === "fulltext"
      ? `全文命中 · 第 ${hit.pageNumber} 页`
      : hit.matchScope === "metadata" ? "元数据命中" : "笔记命中";

    const snippet = document.createElement("div");
    snippet.className = "search-snippet";
    appendSafeHighlightedText(snippet, hit.snippet, hit.highlightTerms);
    item.append(main, scope, snippet);
    return item;
  }));
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
          <span class="draft-badge">待确认</span>
          <h3 class="draft-title">${escapeHtml(draft.title || draft.originalFilename || "未识别题名")}</h3>
          <div class="meta-line">${escapeHtml(draft.doi || "未识别 DOI")}</div>
        </button>
      `
    )
    .join("");
}

function renderPapers() {
  if (state.searchResults !== null) {
    renderSearchResults();
    return;
  }
  const container = document.querySelector("#paperList");
  state.selectedPaperIds = new Set(
    [...state.selectedPaperIds].filter((id) => state.papers.some((paper) => paper.id === id))
  );
  document.querySelector("#paperCount").textContent = String(state.papers.length);
  renderCitationSelectionStatus();
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
      const selected = state.selectedPaper?.id === paper.id ? " selected" : "";
      const meta = [(paper.authors || []).join(", "), paper.year, paper.journal].filter(Boolean).join(" · ");
      return `
        <article class="paper-item${selected}" data-paper-id="${paper.id}">
          <input class="paper-select-checkbox" type="checkbox" aria-label="选择引用" data-paper-id="${paper.id}" ${state.selectedPaperIds.has(paper.id) ? "checked" : ""} />
          <div class="paper-card-main">
            <h3 class="paper-title">${escapeHtml(paper.title || "未命名论文")}</h3>
            <div class="paper-meta">${escapeHtml(meta || "未填写作者或来源")}</div>
          </div>
          <div class="chip-row paper-taxonomy">${chips}</div>
          <div class="paper-card-footer">
            <span>${escapeHtml(paper.readingStatus || "to-read")}</span>
            <span>打开原文</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderCitationSelectionStatus() {
  if (!citationElements.selectionStatus) return;
  const count = state.selectedPaperIds.size;
  citationElements.selectionStatus.textContent = count ? `已选择 ${count} 篇引用` : "未选择引用";
}

function renderTrash() {
  workspaceElements.trashCount.textContent = String(state.trash.length);
  if (state.trash.length === 0) {
    workspaceElements.trashList.innerHTML = `<div class="empty-state">回收站为空</div>`;
    return;
  }
  workspaceElements.trashList.innerHTML = `
    <div class="record-table trash-table">
      <div class="record-table-head"><span>标题</span><span>删除时间</span><span>恢复</span><span>彻底删除</span></div>
      ${state.trash.map((paper) => `
        <div class="record-table-row">
          <strong title="${escapeHtml(paper.title || "未命名论文")}">${escapeHtml(paper.title || "未命名论文")}</strong>
          <span>${escapeHtml(formatDateTime(paper.deletedAt))}</span>
          <button type="button" class="secondary compact-action" data-action="restore-trash" data-paper-id="${paper.id}">恢复</button>
          <button type="button" class="secondary compact-action danger-action" data-action="purge-trash" data-paper-id="${paper.id}">彻底删除</button>
        </div>
      `).join("")}
    </div>
  `;
}

function duplicatePairs(ids, reason) {
  const uniqueIds = [...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id)))].sort((left, right) => left - right);
  const pairs = [];
  for (let leftIndex = 0; leftIndex < uniqueIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < uniqueIds.length; rightIndex += 1) {
      pairs.push({ sourcePaperId: uniqueIds[leftIndex], paperId: uniqueIds[rightIndex], reason });
    }
  }
  return pairs;
}

function buildDuplicateRows(groups, papers) {
  const paperIds = new Set(papers.map((paper) => paper.id));
  const rows = [];
  for (const group of groups.sha256 || []) rows.push(...duplicatePairs(group.paperIds || [], "sha256"));
  for (const group of groups.doi || []) rows.push(...duplicatePairs(group.paperIds || [], "doi"));
  for (const group of groups.title || []) {
    if (Array.isArray(group.paperIds)) rows.push(...duplicatePairs(group.paperIds, "title"));
    else if (group.sourcePaperId && group.paperId) {
      rows.push({ sourcePaperId: group.sourcePaperId, paperId: group.paperId, reason: "title", score: group.score });
    }
  }
  return [...new Map(rows
    .filter((row) => paperIds.has(row.sourcePaperId) && paperIds.has(row.paperId))
    .map((row) => [`${Math.min(row.sourcePaperId, row.paperId)}:${Math.max(row.sourcePaperId, row.paperId)}`, row])
  ).values()];
}

function renderDuplicateCandidates() {
  const papersById = new Map(state.papers.map((paper) => [paper.id, paper]));
  if (state.duplicateRows.length === 0) {
    workspaceElements.duplicateCandidates.innerHTML = `<div class="empty-state">暂未发现重复论文</div>`;
    return;
  }
  workspaceElements.duplicateCandidates.innerHTML = state.duplicateRows.map((row) => {
    const source = papersById.get(row.sourcePaperId);
    const target = papersById.get(row.paperId);
    return `
      <div class="duplicate-row">
        <span class="reason-chip">${duplicateReasonLabel(row.reason)}</span>
        <button type="button" class="record-link" data-action="open-duplicate" data-paper-id="${source.id}">${escapeHtml(source.title || "未命名论文")}</button>
        <span class="duplicate-separator">与</span>
        <button type="button" class="record-link" data-action="open-duplicate" data-paper-id="${target.id}">${escapeHtml(target.title || "未命名论文")}</button>
        <div class="record-actions">
          <button type="button" class="secondary compact-action" data-action="merge-duplicate" data-target-id="${source.id}" data-source-id="${target.id}">合并两个记录</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderBackups() {
  if (state.backups.length === 0) {
    workspaceElements.backupList.innerHTML = `<div class="empty-state">暂无备份</div>`;
    return;
  }
  const typeLabels = { database: "数据库", full: "完整", automatic: "自动" };
  workspaceElements.backupList.innerHTML = `
    <div class="record-table backup-table">
      <div class="record-table-head"><span>备份类型</span><span>时间</span><span>大小</span><span>校验状态</span><span>恢复</span></div>
      ${state.backups.map((backup) => `
        <div class="record-table-row">
          <span>${typeLabels[backup.backupType] || escapeHtml(backup.backupType)}</span>
          <span>${escapeHtml(formatDateTime(backup.createdAt))}</span>
          <span>${formatBytes(backup.sizeBytes)}</span>
          <span class="status-text">已登记</span>
          <button type="button" class="secondary compact-action" data-action="restore-backup" data-backup-id="${backup.id}">恢复</button>
        </div>
      `).join("")}
    </div>
  `;
}

function projectStatusLabel(status) {
  return { active: "进行中", archived: "已归档" }[status] || status;
}

function renderProjects() {
  const visible = state.projects.filter((project) => state.projectStatusFilter === "all" || project.status === state.projectStatusFilter);
  workspaceElements.projectList.innerHTML = visible.length
    ? visible.map((project) => `
      <article class="project-item${state.selectedProject?.id === project.id ? " selected" : ""}" data-project-id="${project.id}">
        <button type="button" class="project-select" data-action="select-project" data-project-id="${project.id}">
          <strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(projectStatusLabel(project.status))}</span>
        </button>
        <button type="button" class="secondary compact-action project-edit" data-action="edit-project" data-project-id="${project.id}" title="编辑项目">编辑</button>
      </article>
    `).join("")
    : `<div class="empty-state">暂无项目</div>`;
}

function renderProjectQueue() {
  const project = state.selectedProject;
  workspaceElements.projectQueueTitle.textContent = project?.name || "阅读队列";
  workspaceElements.projectQueueMeta.textContent = project ? `${state.projectPapers.length} 篇论文 · ${projectStatusLabel(project.status)}` : "请选择项目";
  document.querySelector("#addPaperToProjectButton").disabled = !project;
  if (!state.projectPapers.length) {
    workspaceElements.projectQueueList.innerHTML = `<div class="empty-state">项目中还没有论文</div>`;
    return;
  }
  workspaceElements.projectQueueList.innerHTML = state.projectPapers.map((relation) => `
    <article class="project-paper-item${relation.paperStatus === "inactive" ? " is-inactive" : ""}" data-paper-id="${relation.paperId}">
      <button type="button" class="project-paper-title" data-action="open-project-paper" data-paper-id="${relation.paperId}">${escapeHtml(relation.title || "未命名论文")}</button>
      <span class="project-paper-meta">${escapeHtml([relation.citationKey, relation.paperStatus === "inactive" ? "inactive" : "active"].filter(Boolean).join(" · "))}</span>
      <div class="project-paper-controls">
        <label>优先级<select data-action="update-project-paper" data-field="priority" data-paper-id="${relation.paperId}">${[1, 2, 3, 4, 5].map((value) => `<option value="${value}"${relation.priority === value ? " selected" : ""}>${value}</option>`).join("")}</select></label>
        <label>立场<select data-action="update-project-paper" data-field="stance" data-paper-id="${relation.paperId}">${["supports", "opposes", "mixed", "background", "unknown"].map((value) => `<option value="${value}"${relation.stance === value ? " selected" : ""}>${value}</option>`).join("")}</select></label>
        <label>状态<select data-action="update-project-paper" data-field="projectStatus" data-paper-id="${relation.paperId}">${["queued", "reading", "reviewed"].map((value) => `<option value="${value}"${relation.projectStatus === value ? " selected" : ""}>${value}</option>`).join("")}</select></label>
        <label class="project-note-field">备注<input data-action="update-project-paper" data-field="projectNote" data-paper-id="${relation.paperId}" value="${escapeHtml(relation.projectNote || "")}" /></label>
        <button type="button" class="secondary compact-action danger-action" data-action="remove-project-paper" data-paper-id="${relation.paperId}">移除</button>
      </div>
    </article>
  `).join("");
}

function renderProjectEvidence() {
  const rows = state.projectEvidenceRows;
  workspaceElements.projectEvidenceMeta.textContent = `${rows.length} 条证据行`;
  if (!rows.length) {
    workspaceElements.projectEvidence.innerHTML = `<div class="empty-state">暂无证据</div>`;
    return;
  }
  workspaceElements.projectEvidence.innerHTML = `
    <div class="project-evidence-row project-evidence-head"><span>论文</span><span>关系</span><span>分类</span><span>研究卡片</span></div>
    ${rows.map((row) => `
      <article class="project-evidence-row">
        <div data-label="论文"><button type="button" class="record-link" data-action="open-evidence-paper" data-paper-id="${row.paperId}">${escapeHtml(row.citationKey || row.title || "未命名论文")}</button><strong>${escapeHtml(row.title || "")}</strong><small>${escapeHtml([row.authors, row.year, row.paperStatus].filter(Boolean).join(" · "))}</small></div>
        <div data-label="关系"><span>${escapeHtml(row.stance)}</span><span>${escapeHtml(row.projectStatus)}</span><span>P${row.priority}</span><small>${escapeHtml(row.projectNote)}</small></div>
        <div data-label="分类"><span>${escapeHtml(row.classification.regions)}</span><span>${escapeHtml(row.classification.periods)}</span><span>${escapeHtml(row.classification.materials)}</span><span>${escapeHtml(row.classification.methods)}</span></div>
        <div data-label="研究卡片">${row.card.quote ? `<button type="button" class="record-link" data-action="open-evidence-card" data-paper-id="${row.paperId}" data-page="${row.card.page}">p.${row.card.page} · ${escapeHtml(row.card.evidenceType)}</button><p>${escapeHtml(row.card.quote)}</p><small>${escapeHtml(row.card.summary)}</small>` : "无卡片"}</div>
      </article>
    `).join("")}
  `;
}

async function loadSelectedProject(project) {
  state.selectedProject = project;
  if (!project) {
    state.projectPapers = [];
    state.projectEvidenceRows = [];
    renderProjectQueue();
    renderProjectEvidence();
    renderResearchScopes();
    renderResearchHistory("project", []);
    return;
  }
  state.projectPapers = await api(`/api/projects/${project.id}/papers`);
  state.projectEvidenceRows = await api(`/api/projects/${project.id}/evidence?format=json`);
  renderProjects();
  renderProjectQueue();
  renderProjectEvidence();
  renderResearchScopes();
  await loadResearchHistory("project", project.id);
}

async function loadProjects() {
  state.projects = await api("/api/projects");
  const selected = state.projects.find((project) => project.id === state.selectedProject?.id) || state.projects[0] || null;
  await loadSelectedProject(selected);
  renderProjects();
}

function openProjectDialog(project = null) {
  const dialog = document.querySelector("#projectDialog");
  document.querySelector("#projectDialogTitle").textContent = project ? "编辑项目" : "创建项目";
  document.querySelector("#projectIdField").value = project?.id || "";
  document.querySelector("#projectNameField").value = project?.name || "";
  document.querySelector("#projectDescriptionField").value = project?.description || "";
  document.querySelector("#projectStatusField").value = project?.status || "active";
  dialog.showModal();
}

async function openProjectPaperDialog() {
  if (!state.selectedProject) return;
  const papers = await loadAllPapers();
  const existing = new Set(state.projectPapers.map((relation) => relation.paperId));
  document.querySelector("#projectPaperChoices").innerHTML = papers.map((paper) => `
    <label class="project-paper-choice${paper.status !== "active" ? " is-inactive" : ""}">
      <input type="checkbox" data-paper-id="${paper.id}"${existing.has(paper.id) ? " checked disabled" : ""}${paper.status !== "active" ? " disabled" : ""} />
      <span>${escapeHtml(paper.title || "未命名论文")}</span><small>${escapeHtml(paper.status || "active")}</small>
    </label>
  `).join("") || `<div class="empty-state">暂无可加入论文</div>`;
  document.querySelector("#projectPaperDialog").showModal();
}

async function openProjectPickerForPaper() {
  if (!state.selectedPaper) return;
  state.projectPaperDialogMode = "projects";
  const projects = await api("/api/projects?status=active");
  const memberships = await Promise.all(projects.map(async (project) => [project.id, await api(`/api/projects/${project.id}/papers`)]));
  const existing = new Set(memberships.filter(([, papers]) => papers.some((paper) => paper.paperId === state.selectedPaper.id)).map(([projectId]) => projectId));
  document.querySelector("#projectPaperChoices").innerHTML = projects.map((project) => `
    <label class="project-paper-choice">
      <input type="checkbox" data-project-id="${project.id}"${existing.has(project.id) ? " checked disabled" : ""} />
      <span>${escapeHtml(project.name)}</span><small>${escapeHtml(projectStatusLabel(project.status))}</small>
    </label>
  `).join("") || `<div class="empty-state">暂无进行中项目</div>`;
  document.querySelector("#projectPaperDialog").showModal();
}

async function openEvidencePaper(paperId, page = null) {
  const paper = (await loadAllPapers()).find((entry) => entry.id === Number(paperId));
  if (!paper) return;
  fillFormFromPaper(paper);
  if (page) await openReader(paper, { targetPage: Number(page) });
  else {
    showWorkspaceView("library");
    renderPapers();
  }
}

function fillFormFromDraft(draft) {
  clearNoteAutosave({ resetDirty: true });
  state.selectedDraft = draft;
  state.selectedPaper = null;
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
  for (const key of noteFieldNames.slice(1)) {
    fields[key].value = "";
  }
  saveElements.button.textContent = "确认入库";
  setPaperSaveState("未修改", "is-neutral");
  saveElements.button.textContent = "仍然单独入库";
  renderEvidence(draft);
  renderDraftDuplicateWarning(draft);
  updateTrashPaperButton();
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

function renderDraftDuplicateWarning(draft) {
  const container = document.querySelector("#draftDuplicateWarning");
  const candidates = draft.duplicateCandidates || [];
  container.hidden = candidates.length === 0;
  if (candidates.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `
    <strong>发现重复候选，请先审阅</strong>
    <p>默认不合并、不删除；仍可选择单独入库。</p>
    <div class="draft-duplicate-list">
      ${candidates.map((candidate) => `
        <div class="draft-duplicate-row">
          <span class="reason-chip">${duplicateReasonLabel(candidate.reason)}</span>
          <span class="draft-candidate-title">${escapeHtml(candidate.title || "未命名论文")}</span>
          <div class="record-actions">
            <button type="button" class="secondary compact-action" data-action="open-draft-candidate" data-paper-id="${candidate.paperId}">打开已有论文</button>
            <button type="button" class="secondary compact-action" data-action="merge-draft" data-paper-id="${candidate.paperId}">合并到此论文</button>
            <button type="button" class="secondary compact-action danger-action" data-action="discard-draft" data-draft-id="${draft.id}">放弃此次上传</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function fillFormFromPaper(paper) {
  document.querySelector("#draftDuplicateWarning").hidden = true;
  document.querySelector("#draftDuplicateWarning").innerHTML = "";
  clearNoteAutosave({ resetDirty: true });
  state.selectedDraft = null;
  state.selectedPaper = paper;
  document.querySelector("#detailTitle").textContent = "论文详情";
  document.querySelector("#detailMode").textContent = "已入库";
  fields.draftId.value = "";
  fields.title.value = paper.title || "";
  fields.authors.value = joinList(paper.authors);
  fields.year.value = paper.year || "";
  fields.doi.value = paper.doi || "";
  fields.journal.value = paper.journal || "";
  fields.volume.value = paper.volume || "";
  fields.issue.value = paper.issue || "";
  fields.pages.value = paper.pages || "";
  fields.publisher.value = paper.publisher || "";
  fields.publicationType.value = paper.publicationType || "article";
  citationElements.key.value = paper.citationKey || "";
  citationElements.status.value = paper.citationStatus || "unverified";
  citationElements.missing.textContent = paper.citationMissingFields?.length
    ? `缺少：${paper.citationMissingFields.join("、")}`
    : "字段完整";
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
  saveElements.button.textContent = "保存更改";
  setPaperSaveState("已保存", "is-success");
  document.querySelector("#evidenceBox").textContent = "已确认论文";
  updateTrashPaperButton();
}

function clearPaperSelection() {
  clearNoteAutosave({ resetDirty: true });
  state.selectedDraft = null;
  state.selectedPaper = null;
  fields.draftId.value = "";
  for (const field of Object.values(fields)) {
    if (field === fields.draftId) continue;
    field.value = "";
  }
  fields.readingStatus.value = "to-read";
  citationElements.key.value = "";
  citationElements.status.value = "unverified";
  citationElements.missing.textContent = "";
  document.querySelector("#detailTitle").textContent = "详情";
  document.querySelector("#detailMode").textContent = "未选择";
  document.querySelector("#draftDuplicateWarning").hidden = true;
  document.querySelector("#draftDuplicateWarning").innerHTML = "";
  document.querySelector("#evidenceBox").textContent = "";
  saveElements.button.textContent = "确认入库";
  setPaperSaveState("未修改", "is-neutral");
  updateTrashPaperButton();
}

function showPaperListView() {
  showWorkspaceView("library");
}

function showReaderView() {
  readerElements.listView.hidden = true;
  readerElements.readerView.hidden = false;
}

function updateTranslationPanel(statusText, resultText = "", { hidden = false } = {}) {
  readerElements.translationPanel.hidden = hidden;
  readerElements.translationStatusText.textContent = statusText;
  readerElements.translationResultText.textContent = resultText || "在原文中选中文字后自动翻译。";
}

function clearAutoTranslateTimer() {
  if (!state.reader.autoTranslateTimer) return;
  window.clearTimeout(state.reader.autoTranslateTimer);
  state.reader.autoTranslateTimer = null;
}

function resetTranslationState() {
  clearAutoTranslateTimer();
  state.reader.lastTranslatedSelection = "";
  state.reader.pendingTranslationSelection = "";
  state.reader.translationRequestId += 1;
}

function updateBookmarkControls() {
  const hasDocument = Boolean(state.reader.document);
  const bookmarkPage = normalizeReaderPage(state.reader.bookmarkPage);
  readerElements.setBookmarkButton.disabled = !hasDocument;
  readerElements.goBookmarkButton.disabled = !hasDocument || !bookmarkPage;
  readerElements.bookmarkStatusText.textContent = bookmarkPage ? `书签 第 ${bookmarkPage} 页` : "未设书签";
  readerElements.translateSelectionButton.disabled = !hasDocument;
}

function updateReaderControls() {
  const { pageNumber, pageCount, scale } = state.reader;
  readerElements.pageNumberInput.value = String(pageNumber || 1);
  readerElements.pageNumberInput.max = String(pageCount || 1);
  readerElements.pageCountText.textContent = `/ ${pageCount || 0}`;
  readerElements.zoomText.textContent = `${Math.round(scale * 100)}%`;
  readerElements.previousButton.disabled = pageNumber <= 1;
  readerElements.nextButton.disabled = pageNumber >= pageCount;
  updateBookmarkControls();
}

function mergeReadingProgressIntoState(updatedPaper, paperId) {
  if (!updatedPaper?.id || updatedPaper.id !== paperId || state.reader.paperId !== paperId) return;
  const pendingProgress = state.reader.pendingProgress || {};
  const progress = {};
  for (const field of ["bookmarkPage", "lastReadPage"]) {
    if (Object.hasOwn(updatedPaper, field) && !Object.hasOwn(pendingProgress, field)) {
      progress[field] = normalizeReaderPage(updatedPaper[field]);
    }
  }
  if (Object.hasOwn(progress, "bookmarkPage")) state.reader.bookmarkPage = progress.bookmarkPage;
  if (Object.hasOwn(progress, "lastReadPage")) state.reader.lastReadPage = progress.lastReadPage;
  state.papers = state.papers.map((paper) => (paper.id === paperId ? { ...paper, ...progress } : paper));
  if (state.selectedPaper?.id === paperId) state.selectedPaper = { ...state.selectedPaper, ...progress };
  updateReaderControls();
}

async function flushReadingProgress({ reportErrors = false, force = false } = {}) {
  if (force && state.reader.progressSaveTimer) {
    clearTimeout(state.reader.progressSaveTimer);
    state.reader.progressSaveTimer = null;
  }
  if (!state.reader.paperId) return null;
  if (state.reader.progressSavePromise) {
    const outcome = await state.reader.progressSavePromise;
    if (outcome.error) {
      state.reader.pendingProgress = requeueReadingProgress(outcome.sentProgress, state.reader.pendingProgress);
      if (reportErrors) setStatus(outcome.error.message);
      return false;
    }
    if (state.reader.pendingProgress) return flushReadingProgress({ reportErrors, force: true });
    return outcome.updatedPaper;
  }
  const progress = state.reader.pendingProgress;
  if (!progress) return null;
  const paperId = state.reader.paperId;
  state.reader.pendingProgress = null;
  const request = api(`/api/papers/${state.reader.paperId}/reading-progress`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(progress)
  });
  state.reader.progressSavePromise = request.then(
    (updatedPaper) => ({ updatedPaper, sentProgress: progress }),
    (error) => ({ error, sentProgress: progress })
  );
  const outcome = await state.reader.progressSavePromise;
  state.reader.progressSavePromise = null;
  if (outcome.error) {
    state.reader.pendingProgress = requeueReadingProgress(outcome.sentProgress, state.reader.pendingProgress);
    if (reportErrors) setStatus(outcome.error.message);
    return false;
  }
  const updatedPaper = outcome.updatedPaper;
  mergeReadingProgressIntoState(updatedPaper, paperId);
  if (state.reader.paperId === paperId && state.reader.pendingProgress) {
    const latestPaper = await flushReadingProgress({ reportErrors, force: true });
    return latestPaper === false ? false : latestPaper || updatedPaper;
  }
  return updatedPaper;
}

async function saveReadingProgress(progress, { reportErrors = false, immediate = false } = {}) {
  if (!state.reader.paperId) return null;
  state.reader.pendingProgress = { ...(state.reader.pendingProgress || {}), ...progress };
  if (state.reader.progressSaveTimer) clearTimeout(state.reader.progressSaveTimer);
  if (!immediate) {
    state.reader.progressSaveTimer = setTimeout(() => {
      state.reader.progressSaveTimer = null;
      void flushReadingProgress();
    }, READING_PROGRESS_AUTOSAVE_DELAY_MS);
    return null;
  }
  state.reader.progressSaveTimer = null;
  return flushReadingProgress({ reportErrors });
}

function recordLastReadPage(pageNumber) {
  const page = normalizeReaderPage(pageNumber);
  if (!page || !state.reader.paperId || page === state.reader.lastReadPage) return;
  state.reader.lastReadPage = page;
  updateBookmarkControls();
  void saveReadingProgress({ lastReadPage: page });
}

async function translateSelectedText({ selectedText = getSelectedReaderText(), allowDuplicate = true } = {}) {
  if (!state.reader.document) return;
  selectedText = String(selectedText || "").replace(/\s+/g, " ").trim();
  if (!selectedText) {
    updateTranslationPanel("未选择文本", "请先在 PDF 中选中文字。");
    setStatus("请先在 PDF 中选中文字");
    return;
  }
  if (
    !allowDuplicate &&
    (selectedText === state.reader.lastTranslatedSelection || selectedText === state.reader.pendingTranslationSelection)
  ) {
    return;
  }

  const requestId = state.reader.translationRequestId + 1;
  state.reader.translationRequestId = requestId;
  state.reader.pendingTranslationSelection = selectedText;
  updateTranslationPanel(`已选择 ${selectedText.length} 个字符`, "正在翻译...");
  setStatus("正在翻译选中文本");
  readerElements.translateSelectionButton.disabled = true;
  try {
    const result = await api("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: selectedText, targetLanguage: "zh-CN" })
    });
    if (requestId !== state.reader.translationRequestId) return;
    state.reader.lastTranslatedSelection = selectedText;
    updateTranslationPanel(`已翻译 ${selectedText.length} 个字符`, result.translatedText || "没有返回译文");
    setStatus("翻译完成");
  } catch (error) {
    if (requestId !== state.reader.translationRequestId) return;
    updateTranslationPanel("翻译失败", error.message);
    setStatus(error.message);
  } finally {
    if (state.reader.pendingTranslationSelection === selectedText) {
      state.reader.pendingTranslationSelection = "";
    }
    if (requestId === state.reader.translationRequestId) updateBookmarkControls();
  }
}

function scheduleSelectedTextTranslation() {
  if (!state.reader.document || readerElements.readerView.hidden) return;
  const selectedText = getSelectedReaderText();
  if (!selectedText) {
    clearAutoTranslateTimer();
    state.reader.pendingTranslationSelection = "";
    return;
  }
  if (selectedText === state.reader.lastTranslatedSelection || selectedText === state.reader.pendingTranslationSelection) {
    return;
  }

  clearAutoTranslateTimer();
  state.reader.autoTranslateTimer = window.setTimeout(() => {
    state.reader.autoTranslateTimer = null;
    void translateSelectedText({ selectedText, allowDuplicate: false });
  }, AUTO_TRANSLATE_DELAY_MS);
}

function resetRenderedPages() {
  if (state.reader.observer) {
    state.reader.observer.disconnect();
    state.reader.observer = null;
  }
  state.reader.pageShells.clear();
  state.reader.renderedPages.clear();
  state.reader.renderingPages.clear();
}

async function closeReaderDocument() {
  const progressSaveResult = await flushReadingProgress({ force: true, reportErrors: true });
  clearReadingProgressQueue();
  state.reader.renderToken += 1;
  resetTranslationState();
  hideSelectionToolbar();
  cancelResearchCardEdit();
  state.reader.annotations = [];
  state.reader.researchCards = [];
  state.reader.annotationResolutions = new Map();
  renderAnnotations();
  renderResearchCards();
  resetRenderedPages();
  if (state.reader.loadingTask?.destroy) {
    await state.reader.loadingTask.destroy().catch(() => {});
  }
  state.reader.loadingTask = null;
  state.reader.document = null;
  state.reader.paperId = null;
  state.reader.pageNumber = 1;
  state.reader.pageCount = 0;
  state.reader.sourceUrl = "";
  state.reader.bookmarkPage = null;
  state.reader.lastReadPage = null;
  return progressSaveResult !== false;
}

function renderTextLayer(pageElement, textContent, viewport) {
  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";
  textLayer.style.width = `${viewport.width}px`;
  textLayer.style.height = `${viewport.height}px`;
  pageElement.append(textLayer);

  for (const item of textContent.items || []) {
    if (!item.str) continue;
    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(transform[2], transform[3]);
    const angle = Math.atan2(transform[1], transform[0]);
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = `${transform[4]}px`;
    span.style.top = `${transform[5] - fontHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.transform = `rotate(${angle}rad)`;
    textLayer.append(span);

    const targetWidth = item.width * viewport.scale;
    const actualWidth = span.getBoundingClientRect().width;
    if (targetWidth > 0 && actualWidth > 0) {
      span.style.transform = `rotate(${angle}rad) scaleX(${targetWidth / actualWidth})`;
    }
  }
}

function getViewerContentWidth() {
  return Math.max(420, readerElements.viewer.clientWidth - 48);
}

function calculateFitWidthScale(page) {
  const viewport = page.getViewport({ scale: 1 });
  const scale = getViewerContentWidth() / viewport.width;
  return Number(Math.min(MAX_READER_SCALE, Math.max(MIN_READER_SCALE, scale)).toFixed(2));
}

function createPageShell(pageNumber, referenceViewport) {
  const shell = document.createElement("div");
  shell.className = "pdf-page-wrapper pdf-page loading";
  shell.setAttribute("data-page-number", String(pageNumber));
  shell.style.width = `${referenceViewport.width}px`;
  shell.style.minHeight = `${referenceViewport.height}px`;
  shell.innerHTML = `<div class="page-loading">第 ${pageNumber} 页</div>`;
  return shell;
}

function releasePageShell(pageNumber) {
  const shell = state.reader.pageShells.get(pageNumber);
  if (!shell || state.reader.renderingPages.has(pageNumber)) return;
  if (!state.reader.renderedPages.has(pageNumber)) return;
  state.reader.renderedPages.delete(pageNumber);
  shell.classList.add("loading");
  shell.replaceChildren(Object.assign(document.createElement("div"), {
    className: "page-loading",
    textContent: `第 ${pageNumber} 页`
  }));
}

async function renderPageShell(pageNumber, token = state.reader.renderToken) {
  const pdfDocument = state.reader.document;
  const shell = state.reader.pageShells.get(pageNumber);
  if (!pdfDocument || !shell) return;
  if (state.reader.renderedPages.has(pageNumber) || state.reader.renderingPages.has(pageNumber)) return;

  state.reader.renderingPages.add(pageNumber);
  shell.classList.add("loading");

  try {
    const page = await pdfDocument.getPage(pageNumber);
    if (state.reader.renderToken !== token) return;

    const viewport = page.getViewport({ scale: state.reader.scale });
    shell.style.width = `${viewport.width}px`;
    shell.style.height = `${viewport.height}px`;
    shell.style.minHeight = `${viewport.height}px`;

    const canvas = document.createElement("canvas");
    const outputScale = Math.min(
      MAX_CANVAS_SCALE,
      Math.max(window.devicePixelRatio || 1, HIGH_RESOLUTION_SCALE)
    );
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const context = canvas.getContext("2d");
    context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
    shell.replaceChildren(canvas);
    shell.classList.remove("loading");

    await page.render({ canvasContext: context, viewport }).promise;
    if (state.reader.renderToken !== token) return;

    const textContent = await page.getTextContent().catch(() => ({ items: [] }));
    renderTextLayer(shell, textContent, viewport);
    restoreAnnotationOverlays(pageNumber, shell);
    state.reader.renderedPages.add(pageNumber);
  } catch (error) {
    if (state.reader.renderToken !== token) return;
    shell.classList.add("loading");
    shell.replaceChildren(Object.assign(document.createElement("div"), {
      className: "page-loading",
      textContent: error.message
    }));
  } finally {
    state.reader.renderingPages.delete(pageNumber);
  }
}

function updateCurrentPageFromScroll() {
  if (readerElements.readerView.hidden || state.reader.pageShells.size === 0) return;

  const viewerRect = readerElements.viewer.getBoundingClientRect();
  let bestPage = state.reader.pageNumber || 1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [pageNumber, shell] of state.reader.pageShells) {
    const rect = shell.getBoundingClientRect();
    if (rect.bottom < viewerRect.top || rect.top > viewerRect.bottom) continue;
    const distance = Math.abs(rect.top - viewerRect.top - 12);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPage = pageNumber;
    }
  }

  if (bestPage !== state.reader.pageNumber) {
    state.reader.pageNumber = bestPage;
    updateReaderControls();
    recordLastReadPage(bestPage);
  }
}

function observeReaderPages(token) {
  state.reader.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.pageNumber);
        if (!pageNumber) continue;
        if (entry.isIntersecting) {
          renderPageShell(pageNumber, token);
        } else {
          releasePageShell(pageNumber);
        }
      }
      updateCurrentPageFromScroll();
    },
    {
      root: readerElements.viewer,
      rootMargin: "900px 0px",
      threshold: 0.01
    }
  );

  for (const shell of state.reader.pageShells.values()) {
    state.reader.observer.observe(shell);
  }
}

function scrollToPage(pageNumber, behavior = "smooth") {
  const nextPage = Math.min(Math.max(Number(pageNumber) || 1, 1), state.reader.pageCount || 1);
  const shell = state.reader.pageShells.get(nextPage);
  if (!shell) return;

  state.reader.pageNumber = nextPage;
  updateReaderControls();
  recordLastReadPage(nextPage);
  renderPageShell(nextPage);
  shell.scrollIntoView({ block: "start", behavior });
}

function scrollToSearchPage(pageNumber) {
  const targetPage = Number(pageNumber);
  if (!Number.isInteger(targetPage) || targetPage < 1) return;
  const page = document.querySelector(`.pdf-page-wrapper[data-page-number="${targetPage}"]`);
  if (!page) return;
  page.scrollIntoView({ block: "start", behavior: "auto" });
  page.classList.add("search-hit");
  window.setTimeout(() => page.classList.remove("search-hit"), 1800);
}

async function renderContinuousPages({ preservePage = false, targetPage = null } = {}) {
  const pdfDocument = state.reader.document;
  if (!pdfDocument) return;

  const requestedPage = targetPage ?? (preservePage ? state.reader.pageNumber : 1);
  const token = state.reader.renderToken + 1;
  state.reader.renderToken = token;
  resetRenderedPages();
  readerElements.viewer.replaceChildren();

  const firstPage = await pdfDocument.getPage(1);
  if (!preservePage) state.reader.scale = calculateFitWidthScale(firstPage);
  const referenceViewport = firstPage.getViewport({ scale: state.reader.scale });

  for (let pageNumber = 1; pageNumber <= state.reader.pageCount; pageNumber += 1) {
    const shell = createPageShell(pageNumber, referenceViewport);
    state.reader.pageShells.set(pageNumber, shell);
    readerElements.viewer.append(shell);
  }

  observeReaderPages(token);
  state.reader.pageNumber = Math.min(Math.max(requestedPage, 1), state.reader.pageCount || 1);
  updateReaderControls();
  requestAnimationFrame(() => scrollToPage(state.reader.pageNumber, "auto"));
}

async function openReader(paper, { targetPage = null } = {}) {
  await closeReaderDocument();
  showReaderView();
  renderPapers();

  const sourceUrl = `/api/papers/${paper.id}/file`;
  const bookmarkPage = normalizeReaderPage(paper.bookmarkPage);
  const lastReadPage = normalizeReaderPage(paper.lastReadPage);
  const requestedPage = normalizeReaderPage(targetPage);
  const resumePage = requestedPage || bookmarkPage || lastReadPage || 1;
  state.reader.paperId = paper.id;
  state.reader.pageNumber = resumePage;
  state.reader.pageCount = 0;
  state.reader.scale = 1;
  state.reader.bookmarkPage = bookmarkPage;
  state.reader.lastReadPage = lastReadPage;
  state.reader.sourceUrl = sourceUrl;
  readerElements.title.textContent = paper.title || "原文阅读";
  readerElements.meta.textContent = [(paper.authors || []).join(", "), paper.year, paper.journal]
    .filter(Boolean)
    .join(" · ");
  readerElements.openButton.href = sourceUrl;
  renderAnnotations();
  renderResearchCards();
  readerElements.viewer.innerHTML = `<div class="empty-state">正在打开原文件</div>`;
  updateTranslationPanel("未选择文本", "", { hidden: true });
  updateReaderControls();

  try {
    state.reader.loadingTask = pdfjsLib.getDocument({ url: sourceUrl });
    state.reader.document = await state.reader.loadingTask.promise;
    state.reader.pageCount = state.reader.document.numPages;
    await loadReaderRecords();
    await renderContinuousPages({ targetPage: resumePage });
    if (requestedPage) requestAnimationFrame(() => scrollToSearchPage(requestedPage));
    setStatus(
      requestedPage
        ? `已跳到搜索命中：第 ${Math.min(requestedPage, state.reader.pageCount)} 页`
        : bookmarkPage
        ? `已跳到书签：第 ${Math.min(bookmarkPage, state.reader.pageCount)} 页`
        : lastReadPage
          ? `已回到上次阅读：第 ${Math.min(lastReadPage, state.reader.pageCount)} 页`
          : "原文已打开"
    );
  } catch (error) {
    state.reader.pageCount = 0;
    readerElements.viewer.innerHTML = `<div class="empty-state">没有找到原文件或无法读取 PDF</div>`;
    setStatus(error.message);
    updateReaderControls();
  }
}

async function closeReaderAndShowList() {
  const progressSaved = await closeReaderDocument();
  readerElements.viewer.innerHTML = `<div class="empty-state">选择论文后阅读原文件</div>`;
  updateTranslationPanel("未选择文本", "", { hidden: true });
  showPaperListView();
  renderPapers();
  if (progressSaved) {
    setStatus("本地资料库");
  } else {
    setStatus("阅读进度未保存");
  }
}

async function moveSelectedPaperToTrash() {
  if (
    !state.selectedPaper ||
    fields.draftId.value ||
    state.metadataSavePromise ||
    state.noteSavePromise ||
    state.trashPaperPromise
  ) return;

  const target = captureTrashTarget(state.selectedPaper);
  state.trashTargetPaper = target;
  updateTrashPaperButton();
  if (!await confirmTrashPaper(target)) {
    if (state.trashTargetPaper === target) state.trashTargetPaper = null;
    updateTrashPaperButton();
    return;
  }
  const confirmedTarget = state.trashTargetPaper;
  state.trashTargetPaper = null;
  updateTrashPaperButton();
  if (!confirmedTarget) return;

  const paperIndex = state.papers.findIndex((entry) => entry.id === confirmedTarget.id);
  const nextPaperId = paperIndex >= 0 ? state.papers[paperIndex + 1]?.id : null;
  const promise = (async () => {
    setStatus("正在移入回收站");
    if (!(await flushPendingNotes())) return;
    if (await flushReadingProgress({ force: true, reportErrors: true }) === false) return;

    const request = buildTrashDeleteRequest(confirmedTarget);
    await api(request.path, request.options);
    await closeReaderDocument();
    readerElements.viewer.innerHTML = `<div class="empty-state">选择论文后阅读原文件</div>`;
    updateTranslationPanel("未选择文本", "", { hidden: true });
    state.papers = state.papers.filter((entry) => entry.id !== confirmedTarget.id);
    if (isTrashTargetSelected(state.selectedPaper, confirmedTarget)) clearPaperSelection();
    await refreshLibraryData();
    showPaperListView();
    const nextPaper = nextPaperId
      ? state.papers.find((entry) => entry.id === nextPaperId)
      : null;
    if (nextPaper) fillFormFromPaper(nextPaper);
    renderPapers();
    setStatus("论文已移入回收站");
  })();
  state.trashPaperPromise = promise;
  updateTrashPaperButton();
  try {
    await promise;
  } catch (error) {
    setStatus(error.message);
  } finally {
    if (state.trashPaperPromise === promise) state.trashPaperPromise = null;
    if (state.trashTargetPaper === confirmedTarget) state.trashTargetPaper = null;
    updateTrashPaperButton();
  }
}

async function openPaperReader(paper) {
  return openReader(paper);
}

async function loadDrafts() {
  state.drafts = await api("/api/drafts");
  renderDrafts();
}

async function loadPapers() {
  const params = new URLSearchParams();
  const query = document.querySelector("#searchInput").value.trim();
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
  state.searchError = "";
  state.searchTotal = 0;
  if (query) {
    state.searchResults = [];
    state.searchLoading = true;
    params.set("q", query);
    params.set("scope", document.querySelector("#searchScope").value);
    renderPapers();
    try {
      const result = await api(`/api/search?${params.toString()}`);
      state.searchResults = result.items || [];
      state.searchTotal = result.total || 0;
    } catch (error) {
      state.searchError = error.message;
    } finally {
      state.searchLoading = false;
    }
    renderPapers();
    return;
  }
  state.searchResults = null;
  state.papers = await api(`/api/papers?${params.toString()}`);
  document.querySelector("#searchResultStatus").hidden = true;
  renderPapers();
  renderResearchScopes();
}

async function loadAllPapers() {
  return api("/api/papers");
}

async function loadTrash() {
  state.trash = await api("/api/trash");
  renderTrash();
}

async function loadBackups() {
  state.backups = await api("/api/backups");
  renderBackups();
}

async function loadDuplicateCandidates() {
  const result = await api("/api/duplicates");
  const papers = await loadAllPapers();
  state.duplicateRows = buildDuplicateRows(result.groups || {}, papers);
  renderDuplicateCandidates();
}

async function refreshLibraryData() {
  await Promise.all([loadPapers(), loadTrash()]);
}

async function openPaperRecord(paperId) {
  const papers = await loadAllPapers();
  const paper = papers.find((item) => item.id === Number(paperId));
  if (!paper) {
    setStatus("未找到候选论文");
    return;
  }
  state.papers = state.papers.some((item) => item.id === paper.id)
    ? state.papers.map((item) => item.id === paper.id ? paper : item)
    : [...state.papers, paper];
  fillFormFromPaper(paper);
  showWorkspaceView("library");
  renderPapers();
  await openPaperReader(paper);
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), Math.min(2000, remaining));
    try {
      const health = await api("/api/health", { signal: controller.signal });
      if (health?.ok) return true;
    } catch {
      // The service may be restarting; keep polling until the bounded deadline.
    } finally {
      window.clearTimeout(timer);
    }
    await delay(Math.min(500, Math.max(100, deadline - Date.now())));
  }
  throw new Error("服务在规定时间内未恢复，请检查服务状态");
}

function metadataPayload() {
  return {
    title: fields.title.value.trim(),
    authors: splitList(fields.authors.value),
    year: fields.year.value ? Number(fields.year.value) : null,
    doi: fields.doi.value.trim(),
    journal: fields.journal.value.trim(),
    volume: fields.volume.value.trim(),
    issue: fields.issue.value.trim(),
    pages: fields.pages.value.trim(),
    publisher: fields.publisher.value.trim(),
    publicationType: fields.publicationType.value,
    abstract: fields.abstract.value.trim(),
    keywords: splitList(fields.keywords.value),
    themes: splitList(fields.themes.value),
    regions: splitList(fields.regions.value),
    periods: splitList(fields.periods.value),
    materials: splitList(fields.materials.value),
    methods: splitList(fields.methods.value),
    proxies: splitList(fields.proxies.value)
  };
}

function notesPayload() {
  return {
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

function formPayload() {
  return { ...metadataPayload(), ...notesPayload() };
}

function restoreLocalFormValues(metadata, notes) {
  fields.title.value = metadata.title;
  fields.authors.value = joinList(metadata.authors);
  fields.year.value = metadata.year || "";
  fields.doi.value = metadata.doi;
  fields.journal.value = metadata.journal;
  fields.abstract.value = metadata.abstract;
  fields.keywords.value = joinList(metadata.keywords);
  fields.themes.value = joinList(metadata.themes);
  fields.regions.value = joinList(metadata.regions);
  fields.periods.value = joinList(metadata.periods);
  fields.materials.value = joinList(metadata.materials);
  fields.methods.value = joinList(metadata.methods);
  fields.proxies.value = joinList(metadata.proxies);
  fields.readingStatus.value = notes.readingStatus;
  fields.notesResearchQuestion.value = notes.notesResearchQuestion;
  fields.notesRegion.value = notes.notesRegion;
  fields.notesMaterialsMethods.value = notes.notesMaterialsMethods;
  fields.notesChronology.value = notes.notesChronology;
  fields.notesCoreFindings.value = notes.notesCoreFindings;
  fields.notesLimits.value = notes.notesLimits;
  fields.notesQuotePoints.value = notes.notesQuotePoints;
  fields.notesPersonal.value = notes.notesPersonal;
}

async function reloadPapersAfterConflict() {
  const message = "论文已在其他操作中更新，已保留本地修改，请检查后重试";
  const selectedPaperId = state.selectedPaper?.id;
  const localMetadata = metadataPayload();
  const localNotes = notesPayload();
  const localNotesDirty = state.notesDirty;
  try {
    const allPapers = await loadAllPapers();
    const latestPaper = allPapers.find((paper) => paper.id === selectedPaperId);
    await loadPapers();
    if (!latestPaper) {
      const missingMessage = "论文冲突恢复失败：未找到当前论文";
      setPaperSaveState(missingMessage, "is-error");
      setStatus(missingMessage);
      return null;
    }
    state.selectedPaper = latestPaper;
    renderPapers();
    restoreLocalFormValues(localMetadata, localNotes);
    state.notesDirty = localNotesDirty;
    setPaperSaveState(message, "is-error");
    setStatus(message);
    return latestPaper || null;
  } catch (error) {
    const reloadError = `刷新失败，已保留本地修改：${error.message}`;
    setPaperSaveState(reloadError, "is-error");
    setStatus(reloadError);
    return null;
  }
}

async function savePaperMetadata() {
  if (!state.selectedPaper) return null;
  if (state.metadataSavePromise) return state.metadataSavePromise;
  setDetailFormLocked(true);
  const promise = (async () => {
    setPaperSaveState("保存中", "is-saving");
    if (!(await flushPendingNotes()) || !state.selectedPaper) return null;
    try {
      const paper = await api(`/api/papers/${state.selectedPaper.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...metadataPayload(),
          expectedVersion: state.selectedPaper.version
        })
      });
      patchPaperInState(paper);
      renderPapers();
      fillFormFromPaper(paper);
      setStatus("论文已保存");
      return paper;
    } catch (error) {
      if (error.status === 409) {
        await reloadPapersAfterConflict();
        return null;
      }
      setPaperSaveState(error.message, "is-error");
      setStatus(error.message);
      return null;
    }
  })();
  state.metadataSavePromise = promise;
  updateTrashPaperButton();
  try {
    return await promise;
  } finally {
    if (state.metadataSavePromise === promise) state.metadataSavePromise = null;
    setDetailFormLocked(false);
  }
}

async function savePaperNotes(requestId = state.noteSaveRequestId) {
  if (requestId !== state.noteSaveRequestId || !state.selectedPaper || fields.draftId.value) return;
  if (state.noteSavePromise) {
    const result = await state.noteSavePromise;
    if (requestId !== state.noteSaveRequestId || !state.notesDirty || !result) return result;
    return savePaperNotes(state.noteSaveRequestId);
  }
  const paperId = state.selectedPaper.id;
  const expectedVersion = state.selectedPaper.version;
  const promise = (async () => {
    setPaperSaveState("保存中", "is-saving");
    try {
      const paper = await api(`/api/papers/${state.selectedPaper.id}/notes`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...notesPayload(), expectedVersion })
      });
      if (state.selectedPaper?.id !== paperId) return paper;
      if (requestId !== state.noteSaveRequestId) {
        if (paper.version > state.selectedPaper.version) {
          state.selectedPaper = { ...state.selectedPaper, version: paper.version };
          state.papers = state.papers.map((entry) =>
            entry.id === paperId ? { ...entry, version: paper.version } : entry
          );
        }
        return paper;
      }
      patchPaperInState(paper);
      renderPapers();
      state.notesDirty = false;
      setPaperSaveState("已保存", "is-success");
      return paper;
    } catch (error) {
      if (error.status === 409) {
        if (state.selectedPaper?.id === paperId) await reloadPapersAfterConflict();
        return null;
      }
      if (requestId !== state.noteSaveRequestId) return null;
      setPaperSaveState(error.message, "is-error");
      setStatus(error.message);
      return null;
    }
  })();
  state.noteSavePromise = promise;
  updateTrashPaperButton();
  try {
    return await promise;
  } finally {
    if (state.noteSavePromise === promise) state.noteSavePromise = null;
  }
}

async function flushPendingNotes() {
  if (state.noteAutosaveTimer) clearTimeout(state.noteAutosaveTimer);
  state.noteAutosaveTimer = null;
  while (state.notesDirty || state.noteSavePromise) {
    const paper = await savePaperNotes(state.noteSaveRequestId);
    if (!paper) return false;
  }
  return true;
}

function scheduleNoteAutosave() {
  if (!state.selectedPaper || fields.draftId.value) return;
  if (state.noteAutosaveTimer) clearTimeout(state.noteAutosaveTimer);
  state.notesDirty = true;
  state.noteSaveRequestId += 1;
  const requestId = state.noteSaveRequestId;
  setPaperSaveState("有未保存笔记", "is-unsaved");
  state.noteAutosaveTimer = setTimeout(() => {
    state.noteAutosaveTimer = null;
    void savePaperNotes(requestId);
  }, NOTE_AUTOSAVE_DELAY_MS);
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

document.querySelector("#paperList").addEventListener("click", async (event) => {
  const checkbox = event.target.closest(".paper-select-checkbox");
  if (checkbox) {
    event.stopPropagation();
    const paperId = Number(checkbox.dataset.paperId);
    if (checkbox.checked) state.selectedPaperIds.add(paperId);
    else state.selectedPaperIds.delete(paperId);
    renderCitationSelectionStatus();
    return;
  }
  const item = event.target.closest("[data-paper-id]");
  if (!item) return;
  const hit = state.searchResults?.find((entry) => entry.paperId === Number(item.dataset.paperId));
  if (hit) {
    try {
      const paper = (await loadAllPapers()).find((entry) => entry.id === hit.paperId);
      if (!paper) throw new Error("未找到论文");
      fillFormFromPaper(paper);
      if (hit.matchScope === "fulltext") {
        await openReader(paper, { targetPage: hit.pageNumber });
      } else {
        showPaperListView();
        renderPapers();
        setStatus("已选择论文详情");
      }
    } catch (error) {
      setStatus(error.message);
    }
    return;
  }
  const paper = state.papers.find((entry) => entry.id === Number(item.dataset.paperId));
  if (!paper) return;
  fillFormFromPaper(paper);
  await openPaperReader(paper);
});

citationElements.verify.addEventListener("click", () => void saveCitation({ status: "verified" }));
citationElements.regenerate.addEventListener("click", () => void saveCitation({ regenerate: true }));
citationElements.status.addEventListener("change", (event) => void saveCitation({ status: event.target.value }));
citationElements.copyInText.addEventListener("click", () => void copyCitation("in-text-apa"));
citationElements.copyBibliography.addEventListener("click", () => void copyCitation("gbt7714"));
citationElements.exportSelected.addEventListener("click", () => void exportSelectedCitations());

document.querySelector("#backToListButton").addEventListener("click", async () => {
  await closeReaderAndShowList();
});

trashElements.button.addEventListener("click", () => void moveSelectedPaperToTrash());

document.querySelector("#previousPageButton").addEventListener("click", () => {
  if (state.reader.pageNumber <= 1) return;
  scrollToPage(state.reader.pageNumber - 1);
});

document.querySelector("#nextPageButton").addEventListener("click", () => {
  if (state.reader.pageNumber >= state.reader.pageCount) return;
  scrollToPage(state.reader.pageNumber + 1);
});

document.querySelector("#pageNumberInput").addEventListener("change", (event) => {
  const nextPage = Number(event.target.value);
  if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > state.reader.pageCount) {
    updateReaderControls();
    return;
  }
  scrollToPage(nextPage);
});

document.querySelector("#zoomOutButton").addEventListener("click", async () => {
  if (!state.reader.document) return;
  state.reader.scale = Math.max(MIN_READER_SCALE, Number((state.reader.scale - 0.15).toFixed(2)));
  await renderContinuousPages({ preservePage: true });
});

document.querySelector("#zoomInButton").addEventListener("click", async () => {
  if (!state.reader.document) return;
  state.reader.scale = Math.min(MAX_READER_SCALE, Number((state.reader.scale + 0.15).toFixed(2)));
  await renderContinuousPages({ preservePage: true });
});

document.querySelector("#setBookmarkButton").addEventListener("click", async () => {
  if (!state.reader.document) return;
  const page = state.reader.pageNumber || 1;
  setStatus("正在保存书签");
  const updatedPaper = await saveReadingProgress(
    { bookmarkPage: page, lastReadPage: page },
    { reportErrors: true, immediate: true }
  );
  if (!updatedPaper) return;
  setStatus(`书签已保存：第 ${state.reader.bookmarkPage} 页`);
});

document.querySelector("#goBookmarkButton").addEventListener("click", () => {
  const bookmarkPage = normalizeReaderPage(state.reader.bookmarkPage);
  if (!bookmarkPage) {
    setStatus("这篇论文还没有书签");
    return;
  }
  scrollToPage(bookmarkPage);
  setStatus(`已跳到书签：第 ${bookmarkPage} 页`);
});

document.querySelector("#translateSelectionButton").addEventListener("click", translateSelectedText);
document.addEventListener("selectionchange", scheduleSelectedTextTranslation);
document.addEventListener("selectionchange", showSelectionToolbar);

readerElements.saveHighlightButton.addEventListener("click", () => void saveSelectedAnnotation("highlight"));
readerElements.saveNoteButton.addEventListener("click", () => void saveSelectedAnnotation("note"));
readerElements.translateAnnotationButton.addEventListener("click", () => {
  const selectedText = state.reader.selection?.quote || getSelectedReaderText();
  void translateSelectedText({ selectedText });
});
readerElements.saveQuoteButton.addEventListener("click", () => void saveSelectedAnnotation("quote"));
readerElements.annotationKindFilter.addEventListener("change", renderAnnotations);
readerElements.annotationColorFilter.addEventListener("change", renderAnnotations);
readerElements.researchCardEditor.addEventListener("submit", saveResearchCardEdit);
readerElements.cancelResearchCardButton.addEventListener("click", cancelResearchCardEdit);

readerElements.annotationList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const annotation = state.reader.annotations.find((entry) => entry.id === Number(button.dataset.annotationId));
  if (!annotation) return;
  if (button.dataset.action === "jump-annotation") scrollToPage(annotation.pageNumber);
  if (button.dataset.action === "edit-annotation") await editAnnotation(annotation);
  if (button.dataset.action === "delete-annotation") await deleteAnnotation(annotation);
});

readerElements.researchCardList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const card = state.reader.researchCards.find((entry) => entry.id === Number(button.dataset.cardId));
  if (!card) return;
  if (button.dataset.action === "jump-card") scrollToPage(card.pageNumber);
  if (button.dataset.action === "edit-card") beginResearchCardEdit(card);
  if (button.dataset.action === "delete-card") {
    if (!await confirmAction("删除研究卡片", "研究卡片会被删除，原始标注保留。", "删除")) return;
    try {
      await api(`/api/research-cards/${card.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      await loadReaderRecords();
    } catch (error) {
      setStatus(error.message);
    }
  }
});

readerElements.viewer.addEventListener("scroll", updateCurrentPageFromScroll);

async function saveCitation({ status = citationElements.status.value, regenerate = false } = {}) {
  if (!state.selectedPaper || fields.draftId.value) return null;
  try {
    const paper = await api(`/api/papers/${state.selectedPaper.id}/citation`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: state.selectedPaper.version,
        citationKey: citationElements.key.value.trim(),
        status,
        regenerate
      })
    });
    patchPaperInState(paper);
    renderPapers();
    fillFormFromPaper(paper);
    setStatus("引用状态已保存");
    return paper;
  } catch (error) {
    setStatus(error.message);
    return null;
  }
}

async function copyCitation(format) {
  if (!state.selectedPaper) return;
  try {
    const response = await fetch(`/api/citations/export?format=${encodeURIComponent(format)}&ids=${state.selectedPaper.id}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    setStatus("引用已复制");
  } catch {
    setStatus("Clipboard 复制失败，请手动复制");
  }
}

async function exportSelectedCitations() {
  const ids = [...state.selectedPaperIds];
  if (!ids.length) {
    setStatus("请先选择论文引用");
    return;
  }
  try {
    const format = citationElements.exportFormat.value;
    const response = await fetch(`/api/citations/export?format=${encodeURIComponent(format)}&ids=${ids.join(",")}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `citations-${format}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus("引用导出已生成");
  } catch (error) {
    setStatus(error.message);
  }
}

document.querySelector("#detailForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = fields.draftId.value;
  if (!id) {
    await savePaperMetadata();
    return;
  }
  if (state.draftConfirmPromise) return state.draftConfirmPromise;
  setDetailFormLocked(true);
  const promise = (async () => {
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
  })();
  state.draftConfirmPromise = promise;
  try {
    await promise;
  } finally {
    if (state.draftConfirmPromise === promise) state.draftConfirmPromise = null;
    setDetailFormLocked(false);
  }
});

for (const key of noteFieldNames) {
  fields[key].addEventListener("input", scheduleNoteAutosave);
  fields[key].addEventListener("change", scheduleNoteAutosave);
}

document.querySelector("#searchButton").addEventListener("click", loadPapers);
document.querySelector("#searchInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadPapers();
});
document.querySelector("#searchScope").addEventListener("change", () => void loadPapers());
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
  document.querySelector("#searchScope").value = "all";
  await loadPapers();
});

async function selectWorkspaceView(view) {
  if (!Object.hasOwn(viewButtons, view)) return;
  if (!readerElements.readerView.hidden) await closeReaderDocument();
  showWorkspaceView(view);
  try {
    if (view === "trash") await loadTrash();
    if (view === "maintenance") await Promise.all([loadDuplicateCandidates(), loadBackups()]);
    if (view === "projects") await loadProjects();
  } catch (error) {
    setStatus(error.message);
  }
}

document.querySelector("#createProjectButton").addEventListener("click", () => openProjectDialog());
document.querySelector("#projectStatusTabs").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-project-status]");
  if (!button) return;
  state.projectStatusFilter = button.dataset.projectStatus;
  for (const tab of document.querySelectorAll("#projectStatusTabs [data-project-status]")) tab.classList.toggle("is-active", tab === button);
  renderProjects();
});

document.querySelector("#projectList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const project = state.projects.find((entry) => entry.id === Number(button.dataset.projectId));
  if (!project) return;
  try {
    if (button.dataset.action === "edit-project") {
      openProjectDialog(project);
      return;
    }
    if (button.dataset.action === "select-project") await loadSelectedProject(project);
  } catch (error) {
    setStatus(error.message);
  }
});

document.querySelector("#projectQueueList").addEventListener("change", async (event) => {
  const control = event.target.closest('[data-action="update-project-paper"]');
  if (!control || !state.selectedProject) return;
  try {
    await api(`/api/projects/${state.selectedProject.id}/papers/${control.dataset.paperId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [control.dataset.field]: control.value })
    });
    await loadSelectedProject(state.selectedProject);
  } catch (error) {
    setStatus(error.message);
  }
});

document.querySelector("#projectQueueList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  try {
    if (button.dataset.action === "open-project-paper") {
      await openEvidencePaper(button.dataset.paperId);
      return;
    }
    if (button.dataset.action !== "remove-project-paper" || !state.selectedProject) return;
    if (!await confirmAction("移除项目论文", "只移除项目关系，不删除论文或研究卡片。", "移除")) return;
    await api(`/api/projects/${state.selectedProject.id}/papers/${button.dataset.paperId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    await loadSelectedProject(state.selectedProject);
  } catch (error) {
    setStatus(error.message);
  }
});

researchElements.library.ask.addEventListener("click", () => void askResearch("library"));
researchElements.project.ask.addEventListener("click", () => void askResearch("project"));
researchElements.library.answer.addEventListener("click", (event) => handleResearchPanelClick("library", event));
researchElements.library.history.addEventListener("click", (event) => handleResearchPanelClick("library", event));
researchElements.project.answer.addEventListener("click", (event) => handleResearchPanelClick("project", event));
researchElements.project.history.addEventListener("click", (event) => handleResearchPanelClick("project", event));
researchElements.library.project.addEventListener("change", () => void loadResearchHistory("library", researchElements.library.project.value));

workspaceElements.projectEvidence.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  try {
    if (button.dataset.action === "open-evidence-paper") await openEvidencePaper(button.dataset.paperId);
    if (button.dataset.action === "open-evidence-card") await openEvidencePaper(button.dataset.paperId, button.dataset.page);
  } catch (error) {
    setStatus(error.message);
  }
});

document.querySelector("#addPaperToProjectButton").addEventListener("click", () => {
  state.projectPaperDialogMode = "papers";
  void openProjectPaperDialog().catch((error) => setStatus(error.message));
});
document.querySelector("#paperAddToProjectButton").addEventListener("click", () => {
  void openProjectPickerForPaper().catch((error) => setStatus(error.message));
});

document.querySelector("#exportProjectEvidenceCsv").addEventListener("click", () => {
  if (state.selectedProject) window.location.href = `/api/projects/${state.selectedProject.id}/evidence?format=csv`;
});
document.querySelector("#exportProjectEvidenceMarkdown").addEventListener("click", () => {
  if (state.selectedProject) window.location.href = `/api/projects/${state.selectedProject.id}/evidence?format=markdown`;
});

document.querySelector("#projectForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "confirm") return;
  event.preventDefault();
  const id = document.querySelector("#projectIdField").value;
  const current = state.projects.find((project) => project.id === Number(id));
  try {
    const project = await api(id ? `/api/projects/${id}` : "/api/projects", {
      method: id ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: document.querySelector("#projectNameField").value,
        description: document.querySelector("#projectDescriptionField").value,
        status: document.querySelector("#projectStatusField").value,
        ...(id ? { expectedVersion: current.version } : {})
      })
    });
    document.querySelector("#projectDialog").close("confirm");
    await loadProjects();
    setStatus(id ? "项目已更新" : "项目已创建");
    if (!id) await loadSelectedProject(project);
  } catch (error) {
    setStatus(error.message);
  }
});

document.querySelector("#projectPaperForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "confirm") return;
  event.preventDefault();
  const defaults = {
    priority: Number(document.querySelector("#projectPaperPriorityField").value),
    stance: document.querySelector("#projectPaperStanceField").value,
    projectStatus: document.querySelector("#projectPaperStatusField").value,
    projectNote: document.querySelector("#projectPaperNoteField").value
  };
  try {
    if (state.projectPaperDialogMode === "projects") {
      const projectIds = [...document.querySelectorAll("#projectPaperChoices [data-project-id]:checked")].map((input) => Number(input.dataset.projectId));
      await Promise.all(projectIds.map((projectId) => api(`/api/projects/${projectId}/papers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paperIds: [state.selectedPaper.id], ...defaults })
      })));
    } else {
      if (!state.selectedProject) return;
      const paperIds = [...document.querySelectorAll("#projectPaperChoices [data-paper-id]:checked:not(:disabled)")].map((input) => Number(input.dataset.paperId));
      if (paperIds.length) await api(`/api/projects/${state.selectedProject.id}/papers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paperIds, ...defaults })
      });
      await loadSelectedProject(state.selectedProject);
    }
    document.querySelector("#projectPaperDialog").close("confirm");
    setStatus("项目关系已更新");
  } catch (error) {
    setStatus(error.message);
  }
});

for (const [view, button] of Object.entries(viewButtons)) {
  button.addEventListener("click", () => void selectWorkspaceView(view));
}

document.querySelector("#trashList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const paperId = Number(button.dataset.paperId);
  try {
    if (button.dataset.action === "restore-trash") {
      await api(`/api/trash/${paperId}/restore`, { method: "POST" });
      await refreshLibraryData();
      setStatus("论文已恢复");
      return;
    }
    if (button.dataset.action === "purge-trash") {
      if (!await confirmAction("彻底删除论文", "该论文及其关联文件将被永久删除，无法恢复。", "彻底删除")) return;
      await api(`/api/trash/${paperId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      await refreshLibraryData();
      setStatus("论文已彻底删除");
    }
  } catch (error) {
    setStatus(error.message);
  }
});

document.querySelector("#emptyTrashButton").addEventListener("click", async () => {
  if (!state.trash.length) return;
  if (!await confirmAction("清空回收站", "回收站中的所有论文及其关联文件将被永久删除，无法恢复。", "清空回收站")) return;
  try {
    await api("/api/trash", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    await refreshLibraryData();
    setStatus("回收站已清空");
  } catch (error) {
    setStatus(error.message);
  }
});

async function createBackup(type) {
  setMaintenanceBusy(true, `正在创建${type === "full" ? "完整" : "数据库"}备份...`);
  try {
    await apiWithTimeout("/api/backups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type })
    }, 30000);
    await loadBackups();
    setStatus("备份已完成");
  } catch (error) {
    setStatus(`备份失败：${error.message}`);
  } finally {
    setMaintenanceBusy(false);
  }
}

document.querySelector("#databaseBackupButton").addEventListener("click", () => void createBackup("database"));
document.querySelector("#fullBackupButton").addEventListener("click", () => void createBackup("full"));
document.querySelector("#scanDuplicatesButton").addEventListener("click", async () => {
  setMaintenanceBusy(true, "正在扫描重复论文...");
  try {
    await apiWithTimeout("/api/duplicates/scan", { method: "POST" }, 30000);
    await loadDuplicateCandidates();
    setStatus("重复论文扫描完成");
  } catch (error) {
    setStatus(`扫描失败：${error.message}`);
  } finally {
    setMaintenanceBusy(false);
  }
});

document.querySelector("#backupList").addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action="restore-backup"]');
  if (!button) return;
  const backupId = Number(button.dataset.backupId);
  if (!await confirmAction("恢复备份", "恢复会替换当前数据库；系统会先保存当前数据库备份。", "恢复备份")) return;
  setMaintenanceBusy(true, "正在恢复备份，等待服务恢复...");
  try {
    await apiWithTimeout(`/api/backups/${backupId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    }, 30000);
    workspaceElements.maintenanceProgress.textContent = "备份已恢复，正在等待服务健康检查...";
    await waitForHealth(20000);
    await Promise.all([loadDrafts(), refreshLibraryData(), loadBackups(), loadDuplicateCandidates()]);
    setStatus("备份恢复完成");
  } catch (error) {
    setStatus(`恢复失败：${error.message}`);
  } finally {
    setMaintenanceBusy(false);
  }
});

document.querySelector("#duplicateCandidates").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "open-duplicate") {
    try {
      await openPaperRecord(button.dataset.paperId);
    } catch (error) {
      setStatus(error.message);
    }
    return;
  }
  if (button.dataset.action !== "merge-duplicate") return;
  if (!await confirmAction("合并重复论文", "将保留第一条记录并把第二条记录合并进去，此操作会先创建备份。", "合并记录")) return;
  try {
    const merged = await api(`/api/papers/${button.dataset.targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: Number(button.dataset.sourceId), confirm: true })
    });
    fillFormFromPaper(merged);
    await Promise.all([loadPapers(), loadBackups(), loadDuplicateCandidates()]);
    setStatus("重复论文已合并");
  } catch (error) {
    setStatus(`合并失败：${error.message}`);
  }
});

document.querySelector("#draftDuplicateWarning").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const draftId = Number(fields.draftId.value);
  try {
    if (button.dataset.action === "open-draft-candidate") {
      await openPaperRecord(button.dataset.paperId);
      return;
    }
    if (button.dataset.action === "merge-draft") {
      if (!await confirmAction("合并上传草稿", "草稿将合并到已有论文，上传文件不再单独入库。", "合并草稿")) return;
      const merged = await api(`/api/drafts/${draftId}/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetPaperId: Number(button.dataset.paperId), confirm: true })
      });
      await Promise.all([loadDrafts(), refreshLibraryData(), loadDuplicateCandidates()]);
      fillFormFromPaper(merged);
      setStatus("上传草稿已合并");
      return;
    }
    if (button.dataset.action === "discard-draft") {
      if (!await confirmAction("放弃此次上传", "该上传草稿及其关联文件将被删除。", "放弃上传")) return;
      await api(`/api/drafts/${draftId}`, { method: "DELETE" });
      await loadDrafts();
      state.selectedDraft = null;
      fields.draftId.value = "";
      document.querySelector("#draftDuplicateWarning").hidden = true;
      document.querySelector("#draftDuplicateWarning").innerHTML = "";
      setStatus("已放弃此次上传");
    }
  } catch (error) {
    setStatus(error.message);
  }
});

await loadDrafts();
await loadPapers();
await loadProjects();
await loadResearchHistory("library");
await loadTrash();
await loadBackups();
await loadDuplicateCandidates();
