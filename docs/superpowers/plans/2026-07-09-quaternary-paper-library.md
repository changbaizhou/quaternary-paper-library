# Quaternary Paper Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first web paper library for Quaternary geology with PDF upload, automatic metadata extraction, taxonomy classification, review-confirm workflow, search, and export.

**Architecture:** Use a Node.js backend to serve both JSON APIs and static assets. Store structured records in SQLite and copy uploaded PDFs into a managed `library/files/` directory. Keep extraction, metadata lookup, classification, repository, export, and API responsibilities in separate JavaScript modules.

**Tech Stack:** Node.js 24, Express, Multer, built-in `node:sqlite`, pdf-parse, built-in `node:test`, vanilla HTML/CSS/JavaScript.

---

## File Structure

- Create: `package.json` - scripts and dependencies.
- Create: `README.md` - setup, run, and usage instructions.
- Create: `src/server.js` - Express app, static serving, and API routes.
- Create: `src/config.js` - paths for database, file store, and static assets.
- Create: `src/database.js` - SQLite connection and schema initialization.
- Create: `src/pdfExtract.js` - PDF text extraction, DOI detection, abstract and keyword parsing.
- Create: `src/metadata.js` - Crossref/OpenAlex DOI metadata enrichment.
- Create: `src/taxonomy.js` - Quaternary geology taxonomy and classifier.
- Create: `src/repository.js` - draft and paper persistence, search, and confirmation.
- Create: `src/exporters.js` - BibTeX, CSV, and Markdown export.
- Create: `public/index.html` - single-page web UI.
- Create: `public/styles.css` - application styling.
- Create: `public/app.js` - browser interactions and API calls.
- Create: `tests/pdfExtract.test.js` - extraction unit tests.
- Create: `tests/taxonomy.test.js` - classifier unit tests.
- Create: `tests/repository.test.js` - SQLite persistence tests.
- Create: `tests/exporters.test.js` - export tests.
- Create: `tests/api.test.js` - API workflow tests.

## Tasks

### Task 1: Project Scaffold and Failing Extraction Tests

- [ ] Create Node project directories and dependency file.
- [ ] Write tests for DOI detection, abstract parsing, and keyword parsing in `tests/pdfExtract.test.js`.
- [ ] Run `npm test -- tests/pdfExtract.test.js` and verify it fails because `src/pdfExtract.js` does not exist.
- [ ] Implement `src/pdfExtract.js` with `detectDoi`, `parseAbstract`, and `parseKeywords`.
- [ ] Run `npm test -- tests/pdfExtract.test.js` and verify it passes.

### Task 2: Taxonomy Classifier

- [ ] Write tests in `tests/taxonomy.test.js` for classifying a lake sediment, Holocene, pollen, Qinghai-Tibet Plateau paper.
- [ ] Run `npm test -- tests/taxonomy.test.js` and verify it fails because `src/taxonomy.js` does not exist.
- [ ] Implement `src/taxonomy.js` with taxonomy entries, alias matching, confidence scoring, and evidence.
- [ ] Run `npm test -- tests/taxonomy.test.js` and verify it passes.

### Task 3: SQLite Repository

- [ ] Write repository tests in `tests/repository.test.js` for creating a draft, retrieving pending drafts, confirming a paper, and searching confirmed papers.
- [ ] Run `npm test -- tests/repository.test.js` and verify it fails because repository functions do not exist.
- [ ] Implement `src/config.js`, `src/database.js`, and `src/repository.js`.
- [ ] Run `npm test -- tests/repository.test.js` and verify it passes.

### Task 4: Exporters

- [ ] Write tests in `tests/exporters.test.js` for BibTeX, CSV, and Markdown export using confirmed paper objects.
- [ ] Run exporter tests and verify they fail because `src/exporters.js` does not exist.
- [ ] Implement `src/exporters.js`.
- [ ] Run exporter tests and verify they pass.

### Task 5: API Workflow

- [ ] Write `tests/api.test.js` for API routes: health check, create draft from text fixture, list pending drafts, confirm draft, search papers, and export BibTeX.
- [ ] Run `npm test -- tests/api.test.js` and verify it fails because API routes do not exist.
- [ ] Implement `src/server.js` routes and local file storage.
- [ ] Run `npm test -- tests/api.test.js` and verify it passes.

### Task 6: Browser UI

- [ ] Implement `public/index.html` with upload, pending review, paper list, detail editor, filters, and export controls.
- [ ] Implement `public/styles.css` with dense research-tool layout.
- [ ] Implement `public/app.js` for upload, pending draft editing, confirmation, searching, paper selection, and export.
- [ ] Run the app with `npm start`.
- [ ] Open `http://127.0.0.1:8000` and manually verify upload, review, confirm, search, and export.

### Task 7: Final Verification

- [ ] Run `npm test`.
- [ ] Start the local server.
- [ ] Confirm the app URL and summarize the implemented scope.
