import { test, expect } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp } from "../../src/server.js";

const paperTitle = "Holocene lake sediment record (confirmed)";
const noteText = "Synthetic browser smoke note saved by the data foundation test.";

let tempDir;
let pdfBytes;
let server;
let baseURL;

async function createFixturePdf() {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Holocene lake sediment record", {
    x: 72,
    y: 700,
    size: 18,
    font,
    color: rgb(0.08, 0.12, 0.14)
  });
  page.drawText("A synthetic one-page PDF for browser validation.", {
    x: 72,
    y: 660,
    size: 12,
    font,
    color: rgb(0.12, 0.16, 0.18)
  });
  page.drawText("Holocene lake sediment records preserve pollen and climate history.", {
    x: 72,
    y: 620,
    size: 12,
    font,
    color: rgb(0.12, 0.16, 0.18)
  });
  return Buffer.from(await document.save());
}

test.beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "qpl-browser-data-foundation-"));
  const dbPath = path.join(tempDir, "library.sqlite");
  const filesDir = path.join(tempDir, "files");
  const backupsDir = path.join(tempDir, "backups");
  await Promise.all([mkdir(filesDir, { recursive: true }), mkdir(backupsDir, { recursive: true })]);
  pdfBytes = await createFixturePdf();

  const app = createApp({
    dbPath,
    filesDir,
    backupsDir,
    staticDir: path.resolve("public"),
    automaticBackupsEnabled: false,
    enableUploadLookup: false,
    translationEnabled: false,
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

test.describe.serial("Task 9 data foundation smoke", () => {
  test("desktop workflow covers upload, persistence, trash, duplicate, backup, and PDF reader", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(`${baseURL}/`);

    await page.locator("#pdfInput").setInputFiles({
      name: "holocene-lake-sediment-record.pdf",
      mimeType: "application/pdf",
      buffer: pdfBytes
    });
    await page.getByRole("button", { name: "上传 PDF" }).click();
    await expect(page.locator("#statusText")).toHaveText("识别完成，等待确认");
    const draft = page.locator("#draftList button[data-draft-id]").first();
    await expect(draft).toBeVisible();
    await draft.click();
    await page.locator("#titleField").fill("Holocene lake sediment record");
    await page.getByRole("button", { name: "仍然单独入库" }).click();
    await expect(page.locator("#statusText")).toHaveText("已确认入库");

    const paper = page.locator("#paperList .paper-item").first();
    await expect(paper).toContainText("Holocene lake sediment record");
    await page.locator("#titleField").fill(paperTitle);
    await page.getByRole("button", { name: "保存更改" }).click();
    await expect(page.locator("#statusText")).toHaveText("论文已保存");
    await expect(page.locator("#paperSaveStatus")).toHaveText("已保存");

    await page.reload();
    await expect(page.locator("#paperList .paper-item")).toContainText(paperTitle);
    await page.locator("#paperList .paper-item").filter({ hasText: paperTitle }).click();
    await expect(page.locator("#readerView")).toBeVisible();
    await page.locator("#backToListButton").click();
    await expect(page.locator("#titleField")).toHaveValue(paperTitle);

    await page.locator("#notesPersonalField").fill(noteText);
    await expect(page.locator("#paperSaveStatus")).toHaveText("有未保存笔记");
    await expect(page.locator("#paperSaveStatus")).toHaveText("已保存", { timeout: 5000 });
    await page.reload();
    await page.locator("#paperList .paper-item").filter({ hasText: paperTitle }).click();
    await page.locator("#backToListButton").click();
    await expect(page.locator("#notesPersonalField")).toHaveValue(noteText);

    await page.locator("#trashPaperButton").click();
    await expect(page.locator("#trashPaperDialog")).toBeVisible();
    await expect(page.locator("#trashPaperDialog")).toContainText(paperTitle);
    await page.locator("#trashPaperDialogCancel").click();
    await expect(page.locator("#paperList .paper-item").filter({ hasText: paperTitle })).toBeVisible();

    await page.locator("#trashPaperButton").click();
    await expect(page.locator("#trashPaperDialog")).toBeVisible();
    await page.locator("#trashPaperDialogConfirm").click();
    await expect(page.locator("#readerView")).toBeHidden();
    await expect(page.locator("#detailMode")).toHaveText("未选择");
    await page.locator("#trashViewButton").click();
    await expect(page.locator("#trashList")).toContainText(paperTitle);
    await page.locator('#trashList button[data-action="restore-trash"]').click();
    await expect(page.locator("#statusText")).toHaveText("论文已恢复");
    await page.locator("#libraryViewButton").click();
    await expect(page.locator("#paperList")).toContainText(paperTitle);

    await page.locator("#pdfInput").setInputFiles({
      name: "holocene-lake-sediment-record-copy.pdf",
      mimeType: "application/pdf",
      buffer: pdfBytes
    });
    await page.getByRole("button", { name: "上传 PDF" }).click();
    await expect(page.locator("#draftList button[data-draft-id]").first()).toBeVisible();
    await page.locator("#draftList button[data-draft-id]").first().click();
    await expect(page.locator("#draftDuplicateWarning")).toContainText("文件完全相同");

    await page.locator("#maintenanceViewButton").click();
    await page.getByRole("button", { name: "备份数据库" }).click();
    await expect(page.locator("#statusText")).toHaveText("备份已完成");
    await expect(page.locator("#backupList .record-table-row")).toContainText("数据库");

    await page.locator("#libraryViewButton").click();
    await page.locator("#paperList .paper-item").filter({ hasText: paperTitle }).click();
    await expect(page.locator("#readerView")).toBeVisible();
    await expect(page.locator("#pdfViewer canvas").first()).toBeVisible();
    const canvasPixels = await page.locator("#pdfViewer canvas").first().evaluate((canvas) => {
      const context = canvas.getContext("2d");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) return true;
      }
      return false;
    });
    expect(canvasPixels).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("desktop-data-foundation.png"), fullPage: true });

    await page.locator("#backToListButton").click();
    await page.locator("#paperList .paper-item").filter({ hasText: paperTitle }).click();
    await expect(page.locator("#pdfViewer canvas").first()).toBeVisible();
  });

  test("mobile layout keeps controls within the viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/`);
    await expect(page.locator("#statusText")).toBeVisible();

    const layout = await page.locator("button:visible, input:visible, select:visible").evaluateAll((elements) => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      controls: elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, id: element.id, left: rect.left, right: rect.right, width: rect.width };
      })
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    for (const control of layout.controls) {
      expect(control.left, `${control.tag}#${control.id} starts outside viewport`).toBeGreaterThanOrEqual(0);
      expect(control.right, `${control.tag}#${control.id} ends outside viewport`).toBeLessThanOrEqual(layout.viewportWidth);
    }

    await page.locator("#paperList .paper-item").filter({ hasText: paperTitle }).click();
    await expect(page.locator("#readerView")).toBeVisible();
    await page.locator("#backToListButton").click();
    await expect(page.locator("#trashPaperButton")).toBeEnabled();

    const deleteRequests = [];
    page.on("request", (request) => {
      if (request.method() === "DELETE" && request.url().includes("/api/papers/")) deleteRequests.push(request.url());
    });
    await page.locator("#trashPaperButton").click();
    await expect(page.locator("#trashPaperDialog")).toBeVisible();
    await expect(page.locator("#trashPaperDialog")).toContainText(paperTitle);

    const dialogLayout = await page.locator("#trashPaperDialog, #trashPaperDialog button:visible").evaluateAll((elements) => ({
      viewportWidth: window.innerWidth,
      controls: elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { id: element.id, left: rect.left, right: rect.right };
      })
    }));
    expect(dialogLayout.controls.length).toBe(3);
    for (const control of dialogLayout.controls) {
      expect(control.left, `#${control.id} starts outside viewport`).toBeGreaterThanOrEqual(0);
      expect(control.right, `#${control.id} ends outside viewport`).toBeLessThanOrEqual(dialogLayout.viewportWidth);
    }
    await page.locator("#trashPaperDialogCancel").click();
    expect(deleteRequests).toHaveLength(0);
    await expect(page.locator("#paperList .paper-item").filter({ hasText: paperTitle })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mobile-data-foundation.png"), fullPage: true });
  });
});
