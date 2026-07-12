import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_LANG = "chi_sim+eng";
const DEFAULT_PAGES = 3;
const DEFAULT_DPI = 220;

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function hasPathSeparator(command) {
  return /[\\/:]/.test(command);
}

function sortPageImages(left, right) {
  const leftNumber = Number(left.match(/-(\d+)\.png$/i)?.[1] || 0);
  const rightNumber = Number(right.match(/-(\d+)\.png$/i)?.[1] || 0);
  return leftNumber - rightNumber || left.localeCompare(right);
}

export function normalizeOcrText(value) {
  return String(value || "")
    .replace(/\u000c/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function runCommand(command, args = [], options = {}) {
  const timeoutMs = toPositiveInteger(options.timeoutMs, 120000);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const result = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) {
        resolve(result);
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`.trim()));
    });
  });
}

export async function commandExists(command, options = {}) {
  if (!command) return false;

  if (hasPathSeparator(command)) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }

  const runner = options.runCommand || runCommand;
  const checker = process.platform === "win32" ? "where.exe" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  try {
    const result = await runner(checker, args, { allowFailure: true, timeoutMs: 10000 });
    return result.code === 0 && Boolean(String(result.stdout || "").trim());
  } catch {
    return false;
  }
}

export async function extractOcrPages(pdfPath, options = {}) {
  const enabled = options.enabled ?? process.env.QPL_OCR_ENABLED !== "0";
  if (!enabled) {
    return { used: false, reason: "disabled", missingTools: [], pages: [] };
  }

  const pdfRenderer = options.pdfRenderer || process.env.QPL_PDFTOPPM_BIN || "pdftoppm";
  const tesseract = options.tesseract || process.env.QPL_TESSERACT_BIN || "tesseract";
  const exists = options.commandExists || commandExists;
  const runner = options.runCommand || runCommand;
  const missingTools = [];

  if (!(await exists(pdfRenderer))) missingTools.push(pdfRenderer);
  if (!(await exists(tesseract))) missingTools.push(tesseract);
  if (missingTools.length) {
    return { used: false, reason: "missing-tools", missingTools: missingTools.map((tool) => path.basename(tool)), pages: [] };
  }

  const pages = toPositiveInteger(options.pages ?? process.env.QPL_OCR_PAGES, DEFAULT_PAGES);
  const dpi = toPositiveInteger(options.dpi ?? process.env.QPL_OCR_DPI, DEFAULT_DPI);
  const lang = options.lang || process.env.QPL_OCR_LANG || DEFAULT_LANG;
  const workRoot = options.workRoot || os.tmpdir();
  const workDir = await mkdtemp(path.join(workRoot, "qpl-ocr-"));

  try {
    const prefix = path.join(workDir, "page");
    await runner(pdfRenderer, [
      "-f",
      "1",
      "-l",
      String(pages),
      "-png",
      "-r",
      String(dpi),
      pdfPath,
      prefix
    ]);

    const imageNames = (await readdir(workDir))
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort(sortPageImages);

    if (!imageNames.length) {
      return { used: false, reason: "no-pages", missingTools: [], pages: [] };
    }

    const pageResults = [];
    for (const imageName of imageNames) {
      const imagePath = path.join(workDir, imageName);
      const result = await runner(tesseract, [imagePath, "stdout", "-l", lang, "--psm", "6"]);
      pageResults.push({
        pageNumber: Number(imageName.match(/-(\d+)\.png$/i)?.[1]),
        text: normalizeOcrText(result.stdout),
        source: "ocr",
        language: lang
      });
    }

    return pageResults;
  } catch {
    return {
      used: false,
      reason: "failed",
      missingTools: [],
      pages: []
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function extractOcrText(pdfPath, options = {}) {
  const result = await extractOcrPages(pdfPath, options);
  if (!Array.isArray(result)) {
    return {
      used: false,
      text: "",
      reason: result.reason,
      missingTools: result.missingTools || [],
      pages: result.pages?.length || 0
    };
  }
  const text = normalizeOcrText(result.map((page) => page.text).join("\n"));
  return {
    used: true,
    text,
    reason: text ? "" : "empty-text",
    missingTools: [],
    pages: result.length
  };
}
