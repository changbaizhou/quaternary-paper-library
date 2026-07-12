import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

test("main paper panel contains list and PDF reader views", async () => {
  const html = await readFile("public/index.html", "utf8");

  assert.match(html, /id="paperListView"/);
  assert.match(html, /id="readerView"/);
  assert.match(html, /id="backToListButton"/);
  assert.match(html, /id="pdfViewer"/);
});

test("frontend loads PDF.js and opens selected papers in the reader", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /pdfjs-dist\/build\/pdf\.mjs/);
  assert.match(script, /openPaperReader/);
  assert.match(script, /\/api\/papers\/\$\{paper\.id\}\/file/);
  assert.match(script, /pdfjsLib\.getDocument\(\{\s*url: sourceUrl\s*\}\)/);
});

test("frontend reader supports continuous lazy scrolling", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /renderContinuousPages/);
  assert.match(script, /IntersectionObserver/);
  assert.match(script, /data-page-number/);
  assert.match(script, /scrollToPage/);
});

test("frontend reader uses fit-width high-resolution rendering", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /calculateFitWidthScale/);
  assert.match(script, /HIGH_RESOLUTION_SCALE/);
  assert.match(script, /Math\.max\(window\.devicePixelRatio \|\| 1, HIGH_RESOLUTION_SCALE\)/);
});

test("frontend reader resets state when returning to the list", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /closeReaderAndShowList/);
  const start = script.indexOf("async function closeReaderAndShowList");
  const end = script.indexOf("async function loadDrafts", start);
  assert.doesNotMatch(script.slice(start, end), /state\.selectedPaper\s*=\s*null/);
  assert.match(script, /setStatus\("本地资料库"\)/);
});

test("app shell exposes refined visual layout landmarks", async () => {
  const html = await readFile("public/index.html", "utf8");

  assert.match(html, /class="brand-block"/);
  assert.match(html, /class="[^"]*top-actions[^"]*"/);
  assert.match(html, /class="panel-section search-section"/);
  assert.match(html, /class="detail-section basic-section"/);
  assert.match(html, /class="detail-section notes-section"/);
});

test("paper cards and stylesheet expose polished UI primitives", async () => {
  const script = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(script, /paper-title/);
  assert.match(script, /paper-card-footer/);
  assert.match(css, /--surface-raised/);
  assert.match(css, /\.paper-title/);
  assert.match(css, /\.detail-section/);
});

test("frontend reader exposes one-bookmark reading progress controls", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");

  assert.match(html, /id="setBookmarkButton"/);
  assert.match(html, /id="goBookmarkButton"/);
  assert.match(html, /id="bookmarkStatusText"/);
  assert.match(script, /bookmarkPage/);
  assert.match(script, /lastReadPage/);
  assert.match(script, /\/api\/papers\/\$\{state\.reader\.paperId\}\/reading-progress/);
  assert.match(script, /renderContinuousPages\(\{\s*targetPage/);
});

test("frontend reader exposes selected text translation controls", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(html, /id="translateSelectionButton"/);
  assert.match(html, /id="translationPanel"/);
  assert.match(html, /id="translationResultText"/);
  assert.match(script, /window\.getSelection\(\)/);
  assert.match(script, /\/api\/translate/);
  assert.match(script, /translateSelectedText/);
  assert.match(css, /\.translation-panel/);
});

test("frontend reader automatically translates selected PDF text", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /AUTO_TRANSLATE_DELAY_MS/);
  assert.match(script, /scheduleSelectedTextTranslation/);
  assert.match(script, /document\.addEventListener\("selectionchange", scheduleSelectedTextTranslation\)/);
  assert.match(script, /lastTranslatedSelection/);
  assert.match(script, /pendingTranslationSelection/);
});

test("reader exposes a persistent auto-translate toggle and local translation cache", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");

  assert.match(html, /id="autoTranslateToggle"[^>]*type="checkbox"/);
  assert.match(script, /localStorage\.getItem\(TRANSLATION_CACHE_STORAGE_KEY\)/);
  assert.match(script, /localStorage\.setItem\(TRANSLATION_CACHE_STORAGE_KEY/);
  assert.match(script, /if \(!readerElements\.autoTranslateToggle\.checked\) return;/);
});

test("reader can collapse and reopen the annotation sidebar", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(html, /id="toggleAnnotationsButton"[^>]*aria-pressed="true"/);
  assert.match(script, /function setAnnotationsVisible/);
  assert.match(script, /readerElements\.annotationSidebar\.hidden = !visible/);
  assert.match(css, /\.reader-body\.annotations-hidden\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});

test("workspace can collapse and reopen the search sidebar", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(html, /id="toggleFiltersButton"[^>]*aria-pressed="true"/);
  assert.match(html, /<main[^>]*id="workspace"/);
  assert.match(script, /function setFiltersVisible/);
  assert.match(script, /workspaceElements\.filters\.hidden = !visible/);
  assert.match(css, /\.workspace\.filters-hidden\s*{[^}]*grid-template-columns:\s*minmax\(420px, 1fr\) 456px/s);
});

test("popover menus close on outside interaction and Escape", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /function closeOpenDisclosureMenus/);
  assert.match(script, /document\.addEventListener\("pointerdown", closeOpenDisclosureMenus\)/);
  assert.match(script, /event\.key !== "Escape"/);
});

test("hidden project evidence does not displace the paper detail form", async () => {
  const css = await readFile("public/styles.css", "utf8");

  assert.match(css, /\.project-evidence-panel\[hidden\]\s*{\s*display:\s*none;/);
});

test("task 8 exposes library, trash, and maintenance workspace contracts", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");

  assert.match(html, /id="libraryViewButton"/);
  assert.match(html, /id="trashViewButton"/);
  assert.match(html, /id="maintenanceViewButton"/);
  assert.match(html, /id="duplicateCandidates"/);
  assert.match(html, /id="trashList"/);
  assert.match(html, /id="backupList"/);
  assert.match(script, /\/api\/trash/);
  assert.match(script, /\/api\/backups/);
  assert.match(script, /\/merge/);
});

test("paper detail exposes metadata save and notes autosave wiring", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");

  assert.match(html, /id="savePaperButton"/);
  assert.match(html, /id="paperSaveStatus"/);
  assert.match(script, /\/api\/papers\/\$\{state\.selectedPaper\.id\}/);
  assert.match(script, /\/api\/papers\/\$\{state\.selectedPaper\.id\}\/notes/);
  assert.match(script, /expectedVersion/);
  assert.match(script, /NOTE_AUTOSAVE_DELAY_MS/);
});

test("task 6 exposes project workspace, dialogs, evidence exports, and project routes", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  for (const id of [
    "projectsViewButton", "projectsView", "projectList", "projectStatusTabs", "projectEvidence",
    "projectDialog", "projectForm", "addPaperToProjectButton", "projectPaperDialog",
    "exportProjectEvidenceCsv", "exportProjectEvidenceMarkdown"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-view="projects"/);
  assert.match(script, /\/api\/projects/);
  assert.match(script, /projectStatusTabs/);
  assert.match(script, /projectEvidence/);
  assert.match(script, /paperIds/);
  assert.match(script, /projectPaperDialog/);
  assert.match(script, /method:\s*"DELETE"/);
  assert.match(css, /\.projects-workspace/);
  assert.match(css, /\.project-evidence/);
  assert.match(css, /@media \(max-width: 900px\)/);
});

test("frontend reader exposes page-linked annotation and research-card controls", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  for (const id of [
    "annotationSelectionToolbar",
    "annotationSidebar",
    "researchCardList",
    "saveHighlightButton",
    "saveNoteButton",
    "saveQuoteButton"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /高亮/);
  assert.match(html, /批注/);
  assert.match(html, /翻译/);
  assert.match(html, /保存摘录/);
  assert.ok(script.includes("/api/papers/${state.reader.paperId}/annotations"));
  assert.match(script, /api\/research-cards/);
  assert.match(script, /normalizeTextSelector|buildTextSelector/);
  assert.match(script, /TreeWalker|textContent/);
  assert.match(script, /positionVerified/);
  assert.match(script, /textContent/);
  assert.match(css, /#annotationSelectionToolbar/);
  assert.match(css, /#annotationSidebar/);
  assert.match(css, /@media \(max-width: 900px\)/);
});

test("frontend exposes safe search scopes and page-targeted hit navigation", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");

  assert.match(html, /id="searchScope"/);
  assert.match(script, /\/api\/search\?/);
  assert.match(script, /openReader\(paper, \{\s*targetPage/);
  assert.match(script, /\.pdf-page-wrapper\[data-page-number\]|pdf-page-wrapper/);
  assert.match(script, /scrollIntoView/);
  assert.match(script, /search-hit/);
  assert.match(script, /textContent/);
});

test("task 7 exposes research question panels, routes, page citations, and explicit card saving", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  for (const id of [
    "projectResearchPanel", "libraryResearchPanel", "researchQuestion", "researchProjectScope",
    "researchPaperScope", "askResearchButton", "researchAnswer", "researchHistory", "researchStatus"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(script, /\/api\/research\/ask/);
  assert.match(script, /\/api\/research\/answers/);
  assert.match(script, /AI 生成|AI/);
  assert.match(script, /targetPage/);
  assert.match(script, /save.*research.*card|research-card/i);
  assert.match(script, /textContent/);
  assert.match(css, /\.research-panel/);
  assert.match(css, /@media \(max-width: 900px\)/);
});

test("paper detail exposes a confirmed move-to-trash workflow", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");

  assert.match(html, /id="trashPaperButton"[^>]*>移入回收站</);
  assert.match(html, /id="trashPaperDialog"/);
  assert.match(html, /id="trashPaperDialogTitle"/);
  assert.match(html, /id="trashPaperDialogCancel"/);
  assert.match(html, /id="trashPaperDialogConfirm"/);
  assert.match(script, /trashPaperDialog/);
  assert.match(script, /trashPaperDialogCancel/);
  assert.match(script, /trashPaperDialogConfirm/);
  assert.match(script, /captureTrashTarget/);
  assert.match(script, /buildTrashDeleteRequest/);
  assert.match(script, /method:\s*"DELETE"/);
});

test("citation UI exposes stable metadata, selection, and one batch export menu", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(html, /id="citationExportMenu"/);
  assert.match(html, /id="citationExportFormat"/);
  assert.match(html, /id="exportSelectedCitations"/);
  assert.match(html, /id="copyInTextCitationButton"/);
  assert.match(html, /id="copyBibliographyButton"/);
  assert.match(html, /id="citationKeyField"/);
  assert.match(html, /id="citationStatusField"/);
  assert.match(script, /type="checkbox"/);
  assert.match(script, /stopPropagation\(\)/);
  assert.match(script, /\/api\/citations\/export\?format=/);
  assert.match(script, /navigator\.clipboard\.writeText/);
  assert.match(script, /Clipboard/);
  assert.match(script, /escapeHtml\(paper\.title/);
  assert.match(css, /\.paper-select-checkbox/);
  assert.match(css, /width:\s*18px/);
  assert.match(css, /#annotationSelectionToolbar\[hidden\]/);
});

test("trash confirmation keeps its bound target when selection changes", async () => {
  const script = await readFile("public/app.js", "utf8");
  const targetHelpers = script.match(/function captureTrashTarget[\s\S]*?function isTrashTargetSelected[\s\S]*?\n}/);

  assert.ok(targetHelpers, "trash target helpers are required");
  const context = {};
  vm.runInNewContext(
    `${targetHelpers[0]}
const state = { selectedPaper: { id: 2, title: "Paper B" } };
const target = captureTrashTarget({ id: 1, title: "Paper A" });
state.selectedPaper = { id: 2, title: "Paper B" };
result = {
  request: buildTrashDeleteRequest(target),
  clearsSelection: isTrashTargetSelected(state.selectedPaper, target)
};`,
    context
  );

  assert.equal(JSON.stringify(context.result.request), JSON.stringify({ path: "/api/papers/1", options: { method: "DELETE" } }));
  assert.equal(context.result.clearsSelection, false);
});

test("paper save status has a stable bounded text block", async () => {
  const css = await readFile("public/styles.css", "utf8");

  assert.match(css, /\.paper-save-status\s*\{[\s\S]*height:\s*34px;/);
  assert.match(css, /\.paper-save-status\s*\{[\s\S]*overflow:\s*hidden;/);
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

test("returning from the reader preserves the selected paper detail", async () => {
  const script = await readFile("public/app.js", "utf8");
  const start = script.indexOf("async function closeReaderAndShowList");
  const end = script.indexOf("async function loadDrafts", start);
  const closeReader = script.slice(start, end);

  assert.match(closeReader, /closeReaderDocument\(\)/);
  assert.doesNotMatch(closeReader, /state\.selectedPaper\s*=\s*null/);
  assert.match(closeReader, /showPaperListView\(\)/);
  assert.match(script, /fillFormFromPaper\(paper\);\s*await openPaperReader\(paper\)/);
});

test("paper saves coordinate dirty notes and prevent concurrent metadata submits", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /notesDirty:\s*false/);
  assert.match(script, /noteSavePromise:\s*null/);
  assert.match(script, /metadataSavePromise:\s*null/);
  assert.match(script, /await flushPendingNotes\(\)/);
  assert.match(script, /setDetailFormLocked\(true\)/);
  assert.match(script, /state\.notesDirty\s*=\s*true/);
});

test("reading progress serializes writes and merges only progress fields", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /READING_PROGRESS_AUTOSAVE_DELAY_MS/);
  assert.match(script, /pendingProgress/);
  assert.match(script, /progressSavePromise/);
  assert.match(script, /mergeReadingProgressIntoState/);
  const progressStart = script.indexOf("async function saveReadingProgress");
  const progressEnd = script.indexOf("\n}\n\nfunction recordLastReadPage", progressStart);
  const progressSave = script.slice(progressStart, progressEnd);
  assert.doesNotMatch(progressSave, /patchPaperInState\(updatedPaper\)/);
});

test("409 recovery retains local edits and reports reload failures", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /已保留本地修改/);
  assert.match(script, /const latestPaper = allPapers\.find/);
  assert.match(script, /state\.selectedPaper = latestPaper/);
  assert.match(script, /刷新失败/);
  assert.match(script, /reloadPapersAfterConflict\(\)/);
});

test("metadata and draft submits lock the complete detail form", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /detailEditableControls/);
  assert.match(script, /function setDetailFormLocked/);
  assert.match(script, /setDetailFormLocked\(true\)/);
  assert.match(script, /setDetailFormLocked\(false\)/);
  assert.match(script, /draftConfirmPromise:\s*null/);
  assert.match(script, /if \(state\.draftConfirmPromise\)/);
});

test("closing the reader force-flushes progress and reports failures", async () => {
  const script = await readFile("public/app.js", "utf8");
  const start = script.indexOf("async function closeReaderDocument");
  const end = script.indexOf("function renderTextLayer", start);
  const closeReader = script.slice(start, end);

  assert.match(closeReader, /await flushReadingProgress\(\{\s*force:\s*true/);
  assert.match(closeReader, /progressSaveResult/);
  assert.match(script, /阅读进度未保存/);
  assert.match(script, /progressSavePromise\s*=\s*request\.then\([\s\S]*\(error\)\s*=>\s*\(\{\s*error,\s*sentProgress:\s*progress\s*\}\)/);
});

test("409 recovery loads an unfiltered paper snapshot before refreshing the list", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /async function loadAllPapers/);
  assert.match(script, /const allPapers = await loadAllPapers\(\)/);
  assert.match(script, /const latestPaper = allPapers\.find/);
  assert.match(script, /await loadPapers\(\)/);
  assert.match(script, /论文冲突恢复失败：未找到当前论文/);
});

test("failed reading progress is requeued with newer pending values winning", async () => {
  const script = await readFile("public/app.js", "utf8");
  const helper = script.match(/function requeueReadingProgress\([\s\S]*?\r?\n}\r?\n/);

  assert.ok(helper, "reading progress requeue helper is required");
  const context = {};
  vm.runInNewContext(
    `${helper[0]}\nresult = requeueReadingProgress({ lastReadPage: 4, bookmarkPage: 2 }, { lastReadPage: 9 });`,
    context
  );
  assert.equal(JSON.stringify(context.result), JSON.stringify({ lastReadPage: 9, bookmarkPage: 2 }));
});
