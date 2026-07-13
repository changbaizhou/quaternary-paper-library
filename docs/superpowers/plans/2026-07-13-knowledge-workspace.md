# Paper Knowledge Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect local PDF import, derived paper knowledge, custom terminology, project evidence, and citation writing in one SQLite-backed workflow.

**Architecture:** Add migration 8 and focused pure modules for reference/asset parsing, relation scoring, and writing-draft formatting. Repository methods remain the mutation boundary; Express exposes narrow APIs; the existing frontend gains two dialogs and extends the project evidence surface without replacing the reader.

**Tech Stack:** Node.js, Express, SQLite, PDF.js page text, browser directory input, native SVG, Node test runner, Playwright.

---

### Task 1: Derived Knowledge Schema and Parsers

**Files:**
- Create: `src/knowledge.js`
- Modify: `src/migrations.js`
- Modify: `src/repository.js`
- Create: `tests/knowledge.test.js`
- Modify: `tests/database.test.js`

- [ ] Write failing tests that require migration 8 tables, reference DOI/title/year extraction, figure/table caption extraction, deterministic rebuilds, DOI-first matching, and inactive-paper rejection.
- [ ] Run `node --test tests/knowledge.test.js tests/database.test.js` and confirm failures are caused by missing migration 8 and `knowledge.js`.
- [ ] Implement `parsePaperReferences(pages)`, `parsePaperAssets(pages)`, `scorePaperRelations(paper, candidates)`, repository rebuild/list methods, and stored manual relations.
- [ ] Re-run the two test files and require zero failures.

### Task 2: Custom Terminology and Search Integration

**Files:**
- Modify: `src/taxonomy.js`
- Modify: `src/search.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `tests/taxonomy.test.js`
- Modify: `tests/search.test.js`
- Modify: `tests/api.test.js`

- [ ] Write failing tests for custom-term CRUD, validation, immediate bilingual/alias search expansion, disabled semantic mode, and omission of internal fields.
- [ ] Run `node --test tests/taxonomy.test.js tests/search.test.js tests/api.test.js` and confirm the custom alias query fails before implementation.
- [ ] Add normalized custom term groups to search construction and add `/api/terms` CRUD routes plus paper knowledge/relation routes.
- [ ] Re-run the three test files and require zero failures.

### Task 3: Folder Import and Knowledge Dialogs

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/uiStructure.test.js`
- Modify: `tests/browser/dataFoundation.spec.js`

- [ ] Write failing structure tests for the directory input, terminology dialog, paper-knowledge dialog, relation SVG, reference list, and asset page actions.
- [ ] Run `node --test tests/uiStructure.test.js` and confirm the new controls are absent.
- [ ] Reuse `/api/upload` for directory-selected PDFs, render the term manager, and render a bounded interactive knowledge graph plus reference/asset lists.
- [ ] Re-run the structure test and the focused desktop browser workflow.

### Task 4: Writing Drafts and Evidence Comparison

**Files:**
- Create: `src/writing.js`
- Modify: `src/repository.js`
- Modify: `src/server.js`
- Modify: `src/projects.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `tests/writing.test.js`
- Modify: `tests/projects.test.js`
- Modify: `tests/api.test.js`
- Modify: `tests/uiStructure.test.js`

- [ ] Write failing tests for one draft per project, optimistic version updates, citation insertion bookkeeping, bibliography generation, evidence filtering, statistics, and inline project-relation edits.
- [ ] Run `node --test tests/writing.test.js tests/projects.test.js tests/api.test.js tests/uiStructure.test.js` and confirm failures reflect missing draft APIs and controls.
- [ ] Implement writing-draft validation/repository/API functions and extend the existing project evidence UI with filters, statistics, editing, excerpt insertion, autosave, and bibliography preview.
- [ ] Re-run the focused tests and require zero failures.

### Task 5: Rebuild, Documentation, and Final Verification

**Files:**
- Create: `scripts/rebuildKnowledge.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/startScript.test.js`
- Modify: `tests/browser/researchWorkspace.spec.js`

- [ ] Add a deterministic `npm run rebuild-knowledge` command that rebuilds derived references, assets, and citation relations for active papers without touching files or metadata.
- [ ] Document folder import, knowledge rebuild, term editing, relation graph, writing drafts, and evidence comparison.
- [ ] Run `npm test`, `npm run test:browser`, `git diff --check`, rebuild the real library knowledge index, restart the service, and verify the seven acceptance points once.
