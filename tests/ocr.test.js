import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractOcrText } from "../src/ocr.js";

test("OCR reports unavailable when local tools are missing", async () => {
  const result = await extractOcrText("paper.pdf", {
    enabled: true,
    commandExists: async () => false
  });

  assert.equal(result.used, false);
  assert.equal(result.text, "");
  assert.equal(result.reason, "missing-tools");
});

test("OCR renders PDF pages and joins Tesseract text", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "qpl-ocr-"));
  const pdfPath = path.join(tempDir, "scan.pdf");
  await writeFile(pdfPath, "fake pdf");
  const calls = [];

  try {
    const result = await extractOcrText(pdfPath, {
      enabled: true,
      pages: 2,
      lang: "chi_sim+eng",
      workRoot: tempDir,
      commandExists: async (command) => ["pdftoppm", "tesseract"].includes(command),
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (command === "pdftoppm") {
          const prefix = args.at(-1);
          await writeFile(`${prefix}-1.png`, "");
          await writeFile(`${prefix}-2.png`, "");
          return { stdout: "", stderr: "" };
        }
        const imagePath = args[0];
        return {
          stdout: imagePath.endsWith("-1.png") ? "标题 第一页\n" : "作者 第二页\n",
          stderr: ""
        };
      }
    });

    assert.equal(result.used, true);
    assert.equal(result.reason, "");
    assert.match(result.text, /标题 第一页/);
    assert.match(result.text, /作者 第二页/);
    assert.equal(calls[0].command, "pdftoppm");
    assert.deepEqual(calls[0].args.slice(0, 7), ["-f", "1", "-l", "2", "-png", "-r", "220"]);
    assert.equal(calls.filter((call) => call.command === "tesseract").length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
