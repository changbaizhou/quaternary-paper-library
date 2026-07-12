import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

test("Windows start script launches the local paper library", async () => {
  assert.equal(existsSync("启动论文库.bat"), true);
  const script = await readFile("启动论文库.bat", "utf8");

  assert.match(script, /local\.env\.bat/);
  assert.match(script, /QPL_TRANSLATION_PROVIDER=qwen/);
  assert.match(script, /QPL_QWEN_MODEL=qwen-plus/);
  assert.match(script, /npm install/);
  assert.match(script, /npm start/);
  assert.match(script, /http:\/\/127\.0\.0\.1:8000/);
  assert.match(script, /setlocal/);
  assert.doesNotMatch(script, /set\s+"QPL_OCR_[A-Z0-9_]+=/i);
  assert.doesNotMatch(script, /[A-Z]:\\[^\r\n]*(?:tesseract|pdftoppm|mutool)/i);
  assert.doesNotMatch(script, /(?:AQ\.|sk-[A-Za-z0-9])/);
});

test("local environment batch file is documented but ignored", async () => {
  assert.equal(existsSync("local.env.example.bat"), true);
  const example = await readFile("local.env.example.bat", "utf8");
  const gitignore = await readFile(".gitignore", "utf8");

  assert.match(example, /QWEN_API_KEY=/);
  assert.match(example, /QPL_QWEN_BASE_URL=/);
  assert.doesNotMatch(example, /(?:AQ\.|sk-[A-Za-z0-9]{16,})/);
  assert.match(gitignore, /^local\.env\.bat$/m);
});
