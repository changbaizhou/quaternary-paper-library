# Reading, Retrieval, and Citation Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build page-level full-text search, PDF annotations and research cards, reliable citation exports, project evidence workflows, and page-cited Qwen research answers without weakening the existing local-first data safety guarantees.

**Architecture:** Add versioned SQLite migrations and focused repository modules for page text, annotations, citations, projects, and research answers. All retrieval features share `paper_pages` and SQLite FTS5; the existing PDF reader remains the only document viewer and receives page targets through application state. Each bulk or destructive operation is transactional and backed up before it mutates real library data.

**Tech Stack:** Node.js 24, Express 5, built-in `node:sqlite`, SQLite FTS5, PDF.js, existing Poppler/Tesseract OCR integration, vanilla JavaScript/CSS, Node test runner, Playwright.

---

## Task 1: Complete the Recycle-Bin Entry Workflow

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/uiStructure.test.js`
- Modify: `tests/browser/dataFoundation.spec.js`

- [ ] **Step 1: Write failing UI tests**

Assert an active paper detail exposes `id="trashPaperButton"`, a native dialog exposes `id="trashPaperDialog"`, and the script calls `DELETE /api/papers/:id` only from the dialog confirmation handler.

```js
assert.match(html, /id="trashPaperButton"/);
assert.match(html, /id="trashPaperDialog"/);
assert.match(script, /DELETE/);
assert.match(script, /\/api\/papers\/\$\{paperId\}/);
```

- [ ] **Step 2: Verify the tests fail**

Run: `node --test tests/uiStructure.test.js`

Expected: FAIL because the active-paper trash action is absent.

- [ ] **Step 3: Add the soft-delete UI**

Add a danger-styled “移入回收站” command to the paper detail action bar. Populate the native dialog with the selected title, require a second click, call the existing soft-delete API, clear the current selection, refresh papers and trash, and select the next active paper when available. Disable the action during saves and while no active paper is selected.

- [ ] **Step 4: Extend the browser workflow**

Replace the direct test-side `fetch(..., { method: "DELETE" })` with clicks on `#trashPaperButton` and the dialog confirmation. Verify the paper disappears, appears in trash, and restores.

- [ ] **Step 5: Run and commit**

Run: `node --test tests/uiStructure.test.js tests/api.test.js && npm run test:browser`

Commit: `feat: complete paper recycle bin workflow`

## Task 2: Page-Level Text Storage and Safe Indexing

**Files:**
- Create: `src/pageText.js`
- Modify: `src/migrations.js`
- Modify: `src/repository.js`
- Modify: `src/pdfExtract.js`
- Modify: `src/ocr.js`
- Modify: `src/server.js`
- Create: `tests/pageText.test.js`
- Modify: `tests/database.test.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Write migration and repository tests**

Require migration version 3 to create:

```sql
CREATE TABLE paper_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  text_source TEXT NOT NULL CHECK(text_source IN ('pdf','ocr','mixed')),
  language TEXT NOT NULL DEFAULT '',
  character_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(paper_id, page_number)
);
CREATE VIRTUAL TABLE paper_pages_fts USING fts5(text, content='paper_pages', content_rowid='id');
```

Add insert, update, and delete triggers that keep the external-content FTS table synchronized. Tests must skip with an explicit failure message if the runtime lacks FTS5; production must not silently fall back to `LIKE`.

- [ ] **Step 2: Verify migration tests fail**

Run: `node --test tests/database.test.js tests/pageText.test.js`

Expected: FAIL because migration 3 and page helpers do not exist.

- [ ] **Step 3: Implement page extraction**

`extractPdfPages(pdfPath)` returns:

```js
[
  { pageNumber: 1, text: "...", source: "pdf", language: "" },
  { pageNumber: 2, text: "...", source: "pdf", language: "" }
]
```

Use `pdfjs-dist/legacy/build/pdf.mjs`, disable workers in Node, and join text items using their line-break information. Add `extractOcrPages(pdfPath, options)` to render numbered PNG pages and return one result per image. For pages whose normalized PDF text is below 80 characters, prefer non-empty OCR text; otherwise retain PDF text. Never log extracted text.

- [ ] **Step 4: Implement transactional replacement**

Add repository methods:

```js
replacePaperPages(paperId, pages)
listPaperPages(paperId)
getPaperPage(paperId, pageNumber)
getPaperIndexState(paperId)
```

Validate contiguous positive page numbers, active paper state, source enum, and text length. `replacePaperPages` runs in `BEGIN IMMEDIATE`; extraction occurs before the transaction, so a failed extraction leaves existing pages untouched.

- [ ] **Step 5: Integrate upload confirmation and reindex API**

After draft confirmation, index its source PDF. Add `POST /api/papers/:id/reindex` with `{ "confirm": true }`. Return `202` only if background work is actually scheduled; otherwise perform synchronously and return the indexed page count. For this single-user application, implement synchronously first and return `200`.

- [ ] **Step 6: Test failure preservation and commit**

Test valid PDF pages, sparse-page OCR replacement, missing tools, and an injected extraction failure that preserves old page rows.

Run: `node --test tests/pageText.test.js tests/database.test.js tests/api.test.js`

Commit: `feat: index paper text by page`

## Task 3: FTS5 Search and PDF Page Navigation

**Files:**
- Create: `src/search.js`
- Modify: `src/taxonomy.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `tests/search.test.js`
- Modify: `tests/api.test.js`
- Modify: `tests/uiStructure.test.js`

- [ ] **Step 1: Write search ranking tests**

Create papers with page-level hits and metadata-only hits. Assert:

```js
const results = repo.searchLibrary({ query: "黄土", scope: "all" });
assert.equal(results[0].pageNumber, 3);
assert.match(results[0].snippet, /<mark>loess<\/mark>/i);
```

Tests must cover exact phrase quoting, punctuation-only input, scope selection, current filters, stable pagination, and no raw FTS syntax errors returned to the API.

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/search.test.js tests/api.test.js`

Expected: FAIL because `searchLibrary` and `/api/search` do not exist.

- [ ] **Step 3: Implement safe query building**

Tokenize the user query, quote each FTS token, reject an empty normalized query, and cap at 20 tokens. Expand known Chinese/English Quaternary terms from a bidirectional dictionary in `taxonomy.js`. Generate snippets with SQLite `snippet()` and return escaped text plus structured highlight ranges; never trust FTS markup as arbitrary HTML.

- [ ] **Step 4: Add unified search API**

`GET /api/search?q=&scope=&page=&pageSize=` returns:

```json
{
  "items": [{ "paperId": 1, "title": "...", "matchScope": "fulltext", "pageNumber": 3, "snippet": "...", "score": 1.2 }],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

Metadata and note matches have `pageNumber: null`. Deduplicate multiple page hits only when the UI requests paper grouping; the default preserves page hits.

- [ ] **Step 5: Add search UI and navigation**

Add scope selection, snippets, page labels, loading/empty/error states, and a clear command. Clicking a full-text hit calls `openReader(paper, { targetPage })`; after PDF load, scroll the corresponding page wrapper into view and briefly highlight the result. Metadata hits select paper details without opening the reader.

- [ ] **Step 6: Test and commit**

Run: `node --test tests/search.test.js tests/api.test.js tests/uiStructure.test.js`

Commit: `feat: search full text and jump to source pages`

## Task 4: PDF Annotations and Research Cards

**Files:**
- Create: `src/annotations.js`
- Modify: `src/migrations.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `tests/annotations.test.js`
- Modify: `tests/api.test.js`
- Modify: `tests/uiStructure.test.js`

- [ ] **Step 1: Write migration and API tests**

Migration 4 creates `annotations` and `research_cards` exactly as specified in the design, with foreign-key indexes and optimistic `version`. API tests cover create/list/update/delete, stale version 409, inactive papers, malformed selectors, absolute path omission, and card deletion that leaves its annotation.

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/annotations.test.js tests/api.test.js`

- [ ] **Step 3: Implement annotation selectors**

Normalize selectors to:

```js
{
  quote: "selected source text",
  prefix: "up to 32 preceding characters",
  suffix: "up to 32 following characters",
  start: 120,
  end: 146
}
```

Validate page existence and ensure `quote === page.text.slice(start, end)` when positions are available. If a PDF text layer differs from indexed text, accept quote plus context and mark `positionVerified: false` rather than discarding it.

- [ ] **Step 4: Add reader tools**

On text selection inside a PDF page, show actions: 高亮、批注、翻译、保存摘录. Capture page number from the nearest page wrapper. Render saved highlights in a dedicated overlay that does not alter PDF canvas dimensions. Add a scrollable “本篇标注” sidebar and research-card editor.

- [ ] **Step 5: Restore and navigate**

On reader open, load annotations and restore highlights after each page text layer renders. Clicking a card or annotation jumps to its page. Unresolved selectors remain visible in the sidebar with “待重新定位”.

- [ ] **Step 6: Test and commit**

Run: `node --test tests/annotations.test.js tests/api.test.js tests/uiStructure.test.js`

Commit: `feat: add page-linked annotations and research cards`

## Task 5: Verified Citations and Multi-Format Export

**Files:**
- Create: `src/citations.js`
- Modify: `src/migrations.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `tests/citations.test.js`
- Modify: `tests/exporters.test.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Write citation tests**

Migration 5 adds `citation_key`, `citation_status`, `citation_checked_at`, plus volume, issue, pages, publisher, and publication type where absent. Tests require unique deterministic keys, preservation of an existing key after metadata edits, explicit regeneration, and incomplete-field reporting.

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/citations.test.js tests/exporters.test.js`

- [ ] **Step 3: Implement structured formatting**

Create pure functions:

```js
generateCitationKey(paper, existingKeys)
validateCitationMetadata(paper)
formatGbt7714(paper)
formatApa7(paper)
exportRis(papers)
exportCslJson(papers)
formatInTextCitation(paper, style)
```

Escape each output format correctly. Do not synthesize missing volume, pages, DOI, publisher, or author initials.

- [ ] **Step 4: Add APIs and UI**

Add `PATCH /api/papers/:id/citation` and `GET /api/citations/export?format=&ids=`. Citation detail shows validation status and missing fields. Provide icon actions for copy in-text citation, copy bibliography entry, and export selected papers. Use checkboxes for multi-selection.

- [ ] **Step 5: Test and commit**

Run: `node --test tests/citations.test.js tests/exporters.test.js tests/api.test.js`

Commit: `feat: add verified citation workflows`

## Task 6: Research Projects and Evidence Table

**Files:**
- Create: `src/projects.js`
- Modify: `src/migrations.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `tests/projects.test.js`
- Modify: `tests/api.test.js`
- Modify: `tests/uiStructure.test.js`

- [ ] **Step 1: Write project relationship tests**

Migration 6 creates `research_projects` and `project_papers` with a unique `(project_id, paper_id)` pair. Tests cover one paper in several projects, project-specific status and stance, inactive paper rejection, project deletion retaining papers/cards, and deterministic evidence export.

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/projects.test.js tests/api.test.js`

- [ ] **Step 3: Implement repository and APIs**

Add CRUD methods and routes from the design. All multi-paper mutations run in one `BEGIN IMMEDIATE` transaction and require explicit confirmation for removals. Export evidence as CSV and Markdown using structured paper/card fields.

- [ ] **Step 4: Add project workspace**

Add “项目” to the existing navigation. The view contains a compact project list, reading queue, status tabs, evidence table, and add-paper dialog. Reuse existing paper cards and filters; do not duplicate the PDF or create a dashboard landing page.

- [ ] **Step 5: Test and commit**

Run: `node --test tests/projects.test.js tests/api.test.js tests/uiStructure.test.js`

Commit: `feat: organize papers into research projects`

## Task 7: Page-Cited Qwen Research Answers

**Files:**
- Create: `src/researchAssistant.js`
- Modify: `src/migrations.js`
- Modify: `src/translation.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `tests/researchAssistant.test.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Write retrieval and citation-validation tests**

Migration 7 creates `research_answers`. Mock only the external provider boundary. Tests require retrieval from page rows, project restriction, prompt size limits, insufficient-evidence response, valid citation IDs, rejection of unknown citation IDs, provider failure mapping, and no API key in stored rows or responses.

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/researchAssistant.test.js tests/api.test.js`

- [ ] **Step 3: Implement grounded context building**

Build context entries:

```js
{ citationId: "P12-4", paperId: 12, pageNumber: 4, title: "...", text: "..." }
```

Select at most eight pages and cap combined source text at 12,000 characters. The provider receives only the question and these entries. Require structured JSON `{ answer, citations[] }`; validate every citation ID against the sent context before saving.

- [ ] **Step 4: Add API and UI**

Add `POST /api/research/ask` and `GET /api/research/answers`. Allow optional project and paper filters. Render every citation as a button that opens the corresponding paper page. Mark answers “AI 生成”; provide an explicit command to convert one cited statement into a research card.

- [ ] **Step 5: Test and commit**

Run: `node --test tests/researchAssistant.test.js tests/api.test.js`

Commit: `feat: answer research questions with page citations`

## Task 8: Batch Indexing, Browser Acceptance, and Real-Library Migration

**Files:**
- Create: `scripts/indexLibrary.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/startScript.test.js`
- Modify: `tests/browser/dataFoundation.spec.js`
- Create: `tests/browser/researchWorkspace.spec.js`

- [ ] **Step 1: Add resumable indexing tests**

The script creates a database backup, selects active papers lacking page rows, processes one paper at a time, and records progress only through committed page rows. `--paper <id>` targets one paper; `--retry-failed` retries failures. It never prints extracted text, notes, absolute paths, or secrets.

- [ ] **Step 2: Add browser workflow**

Generate a multi-page PDF and verify at 1366×768:

1. Upload and confirm.
2. Search a phrase present only on page 2 and jump there.
3. Select text, highlight, translate via mock provider, and create a card.
4. Reload and restore the annotation.
5. Generate GB/T 7714, RIS, and CSL-JSON.
6. Add the paper to two projects and export evidence.
7. Ask a mocked research question and open its page citation.
8. Move the paper to trash using the visible button and restore it.

At 390×844, assert no visible button, input, select, dialog, or annotation toolbar overflows the viewport. Capture both screenshots and verify the target PDF canvas contains non-white pixels.

- [ ] **Step 3: Update documentation**

Document full-text indexing, OCR dependencies, search scopes, annotation persistence, citation validation, project workflows, AI privacy, backup behavior, and exact commands:

```powershell
npm run index-library
npm test
npm run test:browser
```

- [ ] **Step 4: Run complete verification**

Run:

```powershell
npm test
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:browser
git diff --check
git status --short
```

- [ ] **Step 5: Rehearse and migrate real data**

Stop the service. Create a full backup. Copy the real database and file metadata into a temporary rehearsal directory, run all migrations, index copies of the existing four papers, and compare paper/draft counts plus metadata, notes, bookmark, reading progress, and file hashes. Only after the rehearsal passes, run migrations on the real database and index it. Restart and verify health, paper count, one PDF read, one FTS query, and Qwen translation without printing content.

- [ ] **Step 6: Final review and publish**

Scan the branch diff for credential patterns, PDF/SQLite/local environment files, and author mismatches. Run one final code review focused on data loss and citation correctness. Fix confirmed issues with regression tests, merge to `main`, rerun tests, and push.

Commit: `test: verify research workspace workflows`
