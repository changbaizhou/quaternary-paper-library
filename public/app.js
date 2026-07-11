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
  trash: [],
  backups: [],
  duplicateRows: [],
  currentView: "library",
  selectedDraft: null,
  selectedPaper: null,
  notesDirty: false,
  noteAutosaveTimer: null,
  noteSaveRequestId: 0,
  noteSavePromise: null,
  metadataSavePromise: null,
  draftConfirmPromise: null,
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
    translationRequestId: 0
  }
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

const saveElements = {
  button: document.querySelector("#savePaperButton"),
  status: document.querySelector("#paperSaveStatus")
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
  translationResultText: document.querySelector("#translationResultText")
};

const workspaceElements = {
  library: document.querySelector("#paperListView"),
  trash: document.querySelector("#trashView"),
  maintenance: document.querySelector("#maintenanceView"),
  trashCount: document.querySelector("#trashCount"),
  trashList: document.querySelector("#trashList"),
  duplicateCandidates: document.querySelector("#duplicateCandidates"),
  backupList: document.querySelector("#backupList"),
  maintenanceProgress: document.querySelector("#maintenanceProgress")
};

const viewButtons = {
  library: document.querySelector("#libraryViewButton"),
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
    trash: workspaceElements.trash,
    maintenance: workspaceElements.maintenance
  })) {
    element.hidden = name !== view;
  }
  readerElements.readerView.hidden = true;
  readerElements.listView.hidden = view !== "library";
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
          <span class="draft-badge">待确认</span>
          <h3 class="draft-title">${draft.title || draft.originalFilename || "未识别题名"}</h3>
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
      const selected = state.selectedPaper?.id === paper.id ? " selected" : "";
      const meta = [(paper.authors || []).join(", "), paper.year, paper.journal].filter(Boolean).join(" · ");
      return `
        <article class="paper-item${selected}" data-paper-id="${paper.id}">
          <div class="paper-card-main">
            <h3 class="paper-title">${paper.title || "未命名论文"}</h3>
            <div class="paper-meta">${meta || "未填写作者或来源"}</div>
          </div>
          <div class="chip-row paper-taxonomy">${chips}</div>
          <div class="paper-card-footer">
            <span>${paper.readingStatus || "to-read"}</span>
            <span>打开原文</span>
          </div>
        </article>
      `;
    })
    .join("");
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
  shell.className = "pdf-page loading";
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

async function openPaperReader(paper) {
  await closeReaderDocument();
  showReaderView();
  renderPapers();

  const sourceUrl = `/api/papers/${paper.id}/file`;
  const bookmarkPage = normalizeReaderPage(paper.bookmarkPage);
  const lastReadPage = normalizeReaderPage(paper.lastReadPage);
  const resumePage = bookmarkPage || lastReadPage || 1;
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
  readerElements.viewer.innerHTML = `<div class="empty-state">正在打开原文件</div>`;
  updateTranslationPanel("未选择文本", "", { hidden: true });
  updateReaderControls();

  try {
    state.reader.loadingTask = pdfjsLib.getDocument({ url: sourceUrl });
    state.reader.document = await state.reader.loadingTask.promise;
    state.reader.pageCount = state.reader.document.numPages;
    await renderContinuousPages({ targetPage: resumePage });
    setStatus(
      bookmarkPage
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
  const item = event.target.closest("[data-paper-id]");
  if (!item) return;
  const paper = state.papers.find((entry) => entry.id === Number(item.dataset.paperId));
  if (!paper) return;
  fillFormFromPaper(paper);
  await openPaperReader(paper);
});

document.querySelector("#backToListButton").addEventListener("click", async () => {
  await closeReaderAndShowList();
});

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

readerElements.viewer.addEventListener("scroll", updateCurrentPageFromScroll);

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

async function selectWorkspaceView(view) {
  if (!Object.hasOwn(viewButtons, view)) return;
  if (!readerElements.readerView.hidden) await closeReaderDocument();
  showWorkspaceView(view);
  try {
    if (view === "trash") await loadTrash();
    if (view === "maintenance") await Promise.all([loadDuplicateCandidates(), loadBackups()]);
  } catch (error) {
    setStatus(error.message);
  }
}

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
await loadTrash();
await loadBackups();
await loadDuplicateCandidates();
