# PDF Selection Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select text in the PDF reader and translate it to Chinese through an optional OpenAI-backed backend route.

**Architecture:** The frontend captures the current PDF text selection and displays translation states in the reader. The backend exposes `POST /api/translate`, validates request size and configuration, and delegates provider calls to a focused translation module.

**Tech Stack:** Node.js, Express, native `fetch`, OpenAI Responses API-compatible HTTP request, existing browser PDF.js reader.

---

### Task 1: Backend Translation API

**Files:**
- Create: `src/translation.js`
- Modify: `src/server.js`
- Test: `tests/api.test.js`

- [ ] Write failing API tests for disabled translation, missing API key, oversized input, and provider success.
- [ ] Implement `translateText(input, options)` in `src/translation.js`.
- [ ] Add `POST /api/translate` to `src/server.js`.
- [ ] Run `npm test -- tests/api.test.js`.

### Task 2: Reader Translation UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `tests/uiStructure.test.js`

- [ ] Write failing frontend structure tests for the translation button, panel, selection read, and `/api/translate` call.
- [ ] Add `翻译选中` button and translation panel to the reader.
- [ ] Capture selected text with `window.getSelection()`.
- [ ] Send selected text to `/api/translate`.
- [ ] Render empty, loading, success, and error states.
- [ ] Run `npm test -- tests/uiStructure.test.js` and `node --check public\app.js`.

### Task 3: Verification And Delivery

**Files:**
- Modify: `README.md` if configuration documentation is needed.

- [ ] Run `npm test`.
- [ ] Run `git diff --check`.
- [ ] Verify local service health and loaded frontend assets.
- [ ] Commit with author `changbaizhou <188980047+changbaizhou@users.noreply.github.com>`.
- [ ] Push `main` through the local GitHub proxy when needed.
