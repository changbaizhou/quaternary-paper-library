import { test, expect } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp } from "../../src/server.js";

let tempDir;
let server;
let baseURL;
let pdfBytes;

async function createFixturePdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage([612, 792]);
  first.drawText("Quaternary research workspace", { x: 72, y: 700, size: 20, font, color: rgb(0.1, 0.15, 0.18) });
  first.drawText("The first page contains background context.", { x: 72, y: 650, size: 13, font });
  const second = document.addPage([612, 792]);
  second.drawText("SECOND_PAGE_UNIQUE_PHRASE", { x: 72, y: 700, size: 20, font, color: rgb(0.05, 0.2, 0.25) });
  second.drawText("This page contains the evidence used by the research workflow.", { x: 72, y: 650, size: 13, font });
  return Buffer.from(await document.save());
}

async function waitForPageTwo(page) {
  await expect(page.locator('#pdfViewer .pdf-page-wrapper[data-page-number="2"] canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#pageNumberInput")).toHaveValue("2");
  await expect(page.locator('#pdfViewer .pdf-page-wrapper[data-page-number="2"] .text-layer')).toContainText("SECOND_PAGE_UNIQUE_PHRASE");
}

async function selectUniquePhrase(page) {
  const layer = page.locator('#pdfViewer .pdf-page-wrapper[data-page-number="2"] .text-layer');
  await layer.evaluate((element) => {
    const phrase = "SECOND_PAGE_UNIQUE_PHRASE";
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.nodeValue.indexOf(phrase);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + phrase.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error("unique phrase was not rendered in the text layer");
  });
  await expect(page.locator("#annotationSelectionToolbar")).toBeVisible();
}

async function exportCitation(page, format, expected) {
  await page.locator("#citationExportMenu summary").click();
  await page.locator("#citationExportMenu").evaluate((menu) => { menu.open = true; });
  await expect(page.locator("#citationExportMenu")).toHaveAttribute("open", "");
  await page.locator("#citationExportFormat").selectOption(format);
  const responsePromise = page.waitForResponse((response) => response.url().includes(`/api/citations/export?format=${format}`));
  await page.locator("#exportSelectedCitations").click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(await response.text()).toMatch(expected);
  await page.locator("#citationExportMenu").evaluate((menu) => { menu.open = false; });
}

async function assertViewport(page) {
  const layout = await page.locator("body").evaluate((body) => {
    const openDialog = body.querySelector("dialog[open]");
    const elements = openDialog
      ? [openDialog, ...openDialog.querySelectorAll("button, input, select, textarea")]
      : [...body.querySelectorAll("button, input, select, textarea")].filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
    return {
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    controls: elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      })
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  for (const control of layout.controls) {
    expect(control.left, `${control.id} starts outside viewport`).toBeGreaterThanOrEqual(0);
    expect(control.right, `${control.id} ends outside viewport`).toBeLessThanOrEqual(layout.viewportWidth);
    expect(control.top, `${control.id} starts outside viewport`).toBeGreaterThanOrEqual(0);
    expect(control.bottom, `${control.id} ends outside viewport`).toBeLessThanOrEqual(844);
  }
}

test.beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "qpl-browser-research-workspace-"));
  const dbPath = path.join(tempDir, "library.sqlite");
  const filesDir = path.join(tempDir, "files");
  const backupsDir = path.join(tempDir, "backups");
  await Promise.all([
    mkdir(filesDir, { recursive: true }),
    mkdir(backupsDir, { recursive: true })
  ]);
  pdfBytes = await createFixturePdf();

  const app = createApp({
    dbPath,
    filesDir,
    backupsDir,
    staticDir: path.resolve("public"),
    automaticBackupsEnabled: false,
    enableUploadLookup: false,
    translationEnabled: true,
    translationProvider: "openai",
    openaiApiKey: "browser-test-key",
    translationFetch: async () => new Response(JSON.stringify({ output_text: "mock translation" }), { status: 200 }),
    researchEnabled: true,
    qwenApiKey: "browser-test-key",
    researchProvider: async ({ context }) => JSON.stringify({
      answer: "The page-two evidence answers the mocked question.",
      citations: [context.items[0].citationId]
    }),
    extractOcrText: async () => ({ text: "" })
  });
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test.describe.serial("research workspace acceptance", () => {
  test("desktop completes indexing, retrieval, reading, evidence, AI, and recycle-bin workflows", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(`${baseURL}/`);

    await page.locator("#pdfInput").setInputFiles({ name: "research-workspace.pdf", mimeType: "application/pdf", buffer: pdfBytes });
    await page.locator("#uploadForm").evaluate((form) => form.requestSubmit());
    await expect(page.locator("#draftList button[data-draft-id]")).toHaveCount(1);
    await page.locator("#draftList button[data-draft-id]").click();
    const confirmPromise = page.waitForResponse((response) => response.url().includes("/api/drafts/") && response.url().endsWith("/confirm"));
    await page.locator("#detailForm #savePaperButton").click();
    const confirmed = await (await confirmPromise).json();
    expect(confirmed.indexState).toBe("indexed");
    expect(confirmed.pageCount).toBe(2);
    const paperId = confirmed.id;
    await expect(page.locator(`#paperList .paper-item[data-paper-id="${paperId}"]`)).toBeVisible();

    await page.locator("#searchInput").fill("SECOND_PAGE_UNIQUE_PHRASE");
    await page.locator("#searchScope").selectOption("fulltext");
    const searchPromise = page.waitForResponse((response) => response.url().includes("/api/search?"));
    await page.locator("#searchButton").click();
    await searchPromise;
    const searchHit = page.locator(`#paperList .search-result-item[data-paper-id="${paperId}"]`);
    await expect(searchHit).toHaveAttribute("data-target-page", "2");
    await searchHit.click();
    await expect(page.locator("#readerView")).toBeVisible();
    await waitForPageTwo(page);
    const canvasHasInk = await page.locator('#pdfViewer .pdf-page-wrapper[data-page-number="2"] canvas').evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) return true;
      }
      return false;
    });
    expect(canvasHasInk).toBe(true);

    await selectUniquePhrase(page);
    await page.locator("#saveHighlightButton").click();
    await expect(page.locator("#annotationList .annotation-item")).toHaveCount(1);
    await selectUniquePhrase(page);
    await page.locator("#saveQuoteButton").click();
    await expect(page.locator("#researchCardEditor")).toBeVisible();
    await page.locator("#cardSummaryField").fill("Page two evidence summary");
    await page.locator("#cardInterpretationField").fill("Page two supports the test conclusion.");
    await page.locator("#saveResearchCardButton").click();
    await expect(page.locator("#researchCardList .research-card-item")).toHaveCount(1);
    await page.reload();
    await page.locator(`#paperList .paper-item[data-paper-id="${paperId}"]`).click();
    await waitForPageTwo(page);
    await expect(page.locator("#annotationList .annotation-item")).toHaveCount(2);
    await page.locator('#annotationList [data-action="jump-annotation"]').first().click();
    await expect(page.locator("#pageNumberInput")).toHaveValue("2");
    await page.locator("#backToListButton").click();

    await page.locator("#authorsField").fill("Test Author");
    await page.locator("#yearField").fill("2024");
    await page.locator("#journalField").fill("Synthetic Journal");
    await page.locator("#volumeField").fill("12");
    await page.locator("#issueField").fill("3");
    await page.locator("#pagesField").fill("1-2");
    await page.locator("#publisherField").fill("Test Publisher");
    await page.locator("#detailForm #savePaperButton").click();
    await expect(page.locator("#paperSaveStatus")).toContainText("保存");
    await page.locator("#verifyCitationButton").click();
    await expect(page.locator("#statusText")).toContainText("引用");
    await page.locator(`#paperList .paper-select-checkbox[data-paper-id="${paperId}"]`).check();
    await exportCitation(page, "gbt7714", /Test Author|Synthetic Journal/);
    await exportCitation(page, "ris", /TY  - JOUR/);
    await exportCitation(page, "csl-json", /"title"/);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    await page.locator("#copyBibliographyButton").click();
    await page.locator("#copyInTextCitationButton").click();

    await page.locator("#projectsViewButton").click();
    await page.locator("#createProjectButton").click();
    await page.locator("#projectNameField").fill("Project Alpha");
    await page.locator("#projectDialogConfirm").click();
    await expect(page.locator("#projectList .project-item")).toHaveCount(1);
    await page.locator("#createProjectButton").click();
    await page.locator("#projectNameField").fill("Project Beta");
    await page.locator("#projectDialogConfirm").click();
    await expect(page.locator("#projectList .project-item")).toHaveCount(2);

    await page.locator("#libraryViewButton").click();
    await page.locator(`#paperList .paper-item[data-paper-id="${paperId}"]`).click();
    await page.locator("#backToListButton").click();
    await page.locator("#paperAddToProjectButton").click();
    await expect(page.locator("#projectPaperDialog")).toBeVisible();
    const projectChoices = page.locator('#projectPaperChoices input[data-project-id]');
    for (let index = 0; index < await projectChoices.count(); index += 1) await projectChoices.nth(index).check();
    await page.locator("#projectPaperDialogConfirm").click();
    await page.locator("#projectsViewButton").click();
    await page.locator("#projectList .project-select").first().click();
    await expect(page.locator("#projectQueueList .project-paper-item")).toHaveCount(1);
    await page.locator('#projectQueueList select[data-field="stance"]').selectOption("supports");
    await expect(page.locator("#projectEvidence")).toContainText("supports");
    const evidenceDownload = page.waitForEvent("download");
    await page.locator("#exportProjectEvidenceCsv").click();
    expect((await evidenceDownload).suggestedFilename()).toMatch(/project-evidence\.csv/);

    await page.locator("#libraryViewButton").click();
    await page.locator("#researchQuestion").fill("What evidence is on SECOND_PAGE_UNIQUE_PHRASE?");
    const researchPromise = page.waitForResponse((response) => response.url().endsWith("/api/research/ask"));
    await page.locator("#askResearchButton").click();
    const researchResponse = await researchPromise;
    expect(researchResponse.status()).toBe(200);
    await expect(page.locator("#researchAnswer")).toContainText("page-two evidence");
    await page.locator('#researchAnswer [data-action="save-research-card"]').click();
    await expect(page.locator("#researchStatus")).toContainText("研究卡片");
    await page.locator('#researchAnswer [data-action="open-research-citation"]').click();
    await waitForPageTwo(page);

    await page.locator("#backToListButton").click();
    await page.locator("#trashPaperButton").click();
    await expect(page.locator("#trashPaperDialog")).toBeVisible();
    await expect(page.locator("#trashPaperDialogConfirm")).toContainText("回收站");
    const trashPromise = page.waitForResponse((response) => response.url().endsWith(`/api/papers/${paperId}`) && response.request().method() === "DELETE");
    await page.locator("#trashPaperDialogConfirm").click();
    await trashPromise;
    await page.locator("#trashViewButton").click();
    await expect(page.locator(`#trashList [data-action="restore-trash"][data-paper-id="${paperId}"]`)).toBeVisible();
    await page.locator(`#trashList [data-action="restore-trash"][data-paper-id="${paperId}"]`).click();
    await page.locator("#libraryViewButton").click();
    await expect(page.locator(`#paperList .paper-item[data-paper-id="${paperId}"]`)).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath("desktop-research-workspace.png"), fullPage: true });
  });

  test("mobile keeps project, reader tools, research answer, and trash dialog inside the viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/`);
    await expect(page.locator("#paperList .paper-item").first()).toBeVisible();
    await page.locator("#projectsViewButton").click();
    await expect(page.locator("#projectsView")).toBeVisible();
    await page.locator("#projectList .project-select").first().click();
    await expect(page.locator("#projectQueueList .project-paper-item")).toHaveCount(1);

    await page.locator("#libraryViewButton").click();
    await page.locator("#paperList .paper-item").first().click();
    await page.locator("#nextPageButton").click();
    await waitForPageTwo(page);
    await selectUniquePhrase(page);
    await expect(page.locator("#annotationSelectionToolbar")).toBeVisible();
    await page.locator("#backToListButton").click();
    await page.locator("#researchQuestion").fill("What evidence is on SECOND_PAGE_UNIQUE_PHRASE?");
    await page.locator("#askResearchButton").click();
    await expect(page.locator("#researchAnswer")).toContainText("page-two evidence");
    await page.locator("#trashPaperButton").click();
    await expect(page.locator("#trashPaperDialog")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await assertViewport(page);
    await page.locator("#trashPaperDialogCancel").click();
    await page.screenshot({ path: testInfo.outputPath("mobile-research-workspace.png"), fullPage: true });
  });
});
