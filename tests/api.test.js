import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createApp } from "../src/server.js";
import { openDb } from "../src/database.js";
import { fingerprintBuffer } from "../src/duplicates.js";
import { PaperRepository } from "../src/repository.js";

async function withServer(callback, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-api-"));
  const app = createApp({
    dbPath: path.join(dir, "library.sqlite"),
    filesDir: path.join(dir, "files"),
    backupsDir: path.join(dir, "backups"),
    automaticBackupsEnabled: false,
    staticDir: path.resolve("public"),
    ...overrides
  });
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await callback(baseUrl, {
      dbPath: path.join(dir, "library.sqlite"),
      dir,
      filesDir: path.join(dir, "files"),
      backupsDir: path.join(dir, "backups")
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("API workflow creates draft, confirms paper, searches, and exports", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "paper.pdf",
        text: `
          Holocene pollen record from a lake core on the Qinghai-Tibet Plateau
          doi: 10.1000/test.
          Abstract
          Lake sediment and pollen assemblages reveal paleoclimate changes in the East Asian monsoon margin during the Holocene.
          Keywords: Holocene; lake sediment; pollen; Qinghai-Tibet Plateau
          Introduction
        `
      })
    });
    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();
    assert.equal(draft.doi, "10.1000/test");
    assert.ok(draft.classification.periods.includes("Holocene"));

    const pendingResponse = await fetch(`${baseUrl}/api/drafts`);
    const pending = await pendingResponse.json();
    assert.equal(pending.length, 1);

    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Holocene pollen record from a lake core",
        notesCoreFindings: "Monsoon variability is reconstructed."
      })
    });
    assert.equal(confirmResponse.status, 201);
    const confirmed = await confirmResponse.json();
    assert.equal(confirmed.title, "Holocene pollen record from a lake core");

    const searchResponse = await fetch(`${baseUrl}/api/papers?query=monsoon&regions=Qinghai-Tibet%20Plateau`);
    const papers = await searchResponse.json();
    assert.equal(papers.length, 1);
    assert.equal(papers[0].id, confirmed.id);

    const exportResponse = await fetch(`${baseUrl}/api/export/bibtex`);
    const bibtex = await exportResponse.text();
    assert.match(bibtex, /@article/);
    assert.match(bibtex, /doi = \{10.1000\/test\}/);
  });
});

test("backup API creates, lists, and restores a database backup", async () => {
  await withServer(async (baseUrl, { dbPath, backupsDir }) => {
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({ title: "Original backup API paper", classification: {}, confidence: {}, evidence: {} });
    repo.confirmDraft(draftId);

    assert.equal((await fetch(`${baseUrl}/api/backups`, { method: "GET" })).status, 200);
    const invalidType = await fetch(`${baseUrl}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "unknown" })
    });
    assert.equal(invalidType.status, 400);

    const created = await fetch(`${baseUrl}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "database" })
    });
    assert.equal(created.status, 201);
    const record = await created.json();
    assert.deepEqual(Object.keys(record).sort(), ["backupType", "createdAt", "id", "sizeBytes"].sort());
    assert.equal(record.backupType, "database");

    const missingConfirmation = await fetch(`${baseUrl}/api/backups/${record.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(missingConfirmation.status, 400);

    repo.createDraft({ title: "Changed backup API paper", classification: {}, confidence: {}, evidence: {} });
    const restored = await fetch(`${baseUrl}/api/backups/${record.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(restored.status, 200);
    assert.equal(new PaperRepository(dbPath).searchPapers()[0].title, "Original backup API paper");

    const backupNames = await readdir(backupsDir);
    let backupDirectory;
    for (const name of backupNames) {
      const candidate = path.join(backupsDir, name, "manifest.json");
      try {
        if (JSON.parse(await readFile(candidate, "utf8")).createdAt === record.createdAt) {
          backupDirectory = path.dirname(candidate);
          break;
        }
      } catch {
        // Ignore non-backup entries while locating the selected record.
      }
    }
    assert.ok(backupDirectory);
    const manifestPath = path.join(backupDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].sha256 = "bad-hash";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const invalidManifest = await fetch(`${baseUrl}/api/backups/${record.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(invalidManifest.status, 400);
  });
});

test("backup API rejects a stored path outside the backup root", async () => {
  await withServer(async (baseUrl, { dbPath, dir }) => {
    const created = await fetch(`${baseUrl}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "database" })
    });
    const record = await created.json();
    const db = openDb(dbPath);
    try {
      db.prepare("UPDATE backup_records SET stored_path = ? WHERE id = ?").run(path.join(dir, "outside"), record.id);
    } finally {
      db.close();
    }

    const response = await fetch(`${baseUrl}/api/backups/${record.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.stringify(await response.json()).includes(dir), false);
  });
});

test("API omits internal file fields from draft and paper responses", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "public.pdf", text: "Public response paper" })
    });
    const draft = await createResponse.json();
    const pending = await (await fetch(`${baseUrl}/api/drafts`)).json();
    for (const body of [draft, pending[0]]) {
      assert.equal("storedFilename" in body, false);
      assert.equal("storedPath" in body, false);
      assert.equal("fileSha256" in body, false);
      assert.equal("paperFiles" in body, false);
    }

    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: draft.title })
    });
    const paper = await confirmResponse.json();
    const papers = await (await fetch(`${baseUrl}/api/papers`)).json();
    for (const body of [paper, papers[0]]) {
      assert.equal("storedFilename" in body, false);
      assert.equal("storedPath" in body, false);
      assert.equal("fileSha256" in body, false);
      assert.equal("paperFiles" in body, false);
    }
  });
});

test("API returns 404 for confirming a missing draft", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/drafts/999999/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Draft not found" });
  });
});

test("API paper merge requires confirmation and creates a backup before success", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const createPaper = (title) => repo.confirmDraft(repo.createDraft({ title, classification: {}, confidence: {}, evidence: {} }));
    const targetId = createPaper("API target");
    const sourceId = createPaper("API source");

    const missingConfirmation = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: sourceId })
    });
    assert.equal(missingConfirmation.status, 400);

    const merged = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: sourceId, confirm: true })
    });
    assert.equal(merged.status, 200);
    assert.equal((await merged.json()).id, targetId);
    assert.equal(repo.searchPapers().length, 1);
    const backups = repo.listBackupRecords();
    assert.equal(backups.length, 1);
    const db = openDb(dbPath);
    try {
      const log = db.prepare("SELECT backup_record_id FROM paper_merge_log WHERE target_paper_id = ?").get(targetId);
      assert.equal(log.backup_record_id, backups[0].id);
    } finally {
      db.close();
    }
    const backupDb = openDb(path.join(backups[0].storedPath, "library.sqlite"));
    try {
      assert.equal(backupDb.prepare("SELECT COUNT(*) AS count FROM paper_merge_log").get().count, 0);
      assert.equal(backupDb.prepare("SELECT deleted_at FROM papers WHERE id = ?").get(sourceId).deleted_at, null);
    } finally {
      backupDb.close();
    }
  });
});

test("API merge returns 400, 404, and 409 for invalid paper merge states", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const createPaper = (title) => repo.confirmDraft(repo.createDraft({ title, classification: {}, confidence: {}, evidence: {} }));
    const targetId = createPaper("Error target");
    const sourceId = createPaper("Error source");

    const same = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: targetId, confirm: true })
    });
    assert.equal(same.status, 400);

    const missing = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: 999999, confirm: true })
    });
    assert.equal(missing.status, 404);

    repo.trashPaper(sourceId);
    const trashed = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: sourceId, confirm: true })
    });
    assert.equal(trashed.status, 409);
  });
});

test("API draft merge validates pending and active states and does not create a second paper", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const targetId = repo.confirmDraft(repo.createDraft({ title: "Draft merge target", classification: {}, confidence: {}, evidence: {} }));
    const draftId = repo.createDraft({ title: "Duplicate draft", storedPath: "2026/duplicate.pdf", classification: {}, confidence: {}, evidence: {} });

    const missingConfirmation = await fetch(`${baseUrl}/api/drafts/${draftId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetPaperId: targetId })
    });
    assert.equal(missingConfirmation.status, 400);

    const merged = await fetch(`${baseUrl}/api/drafts/${draftId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetPaperId: targetId, confirm: true })
    });
    assert.equal(merged.status, 200);
    assert.equal((await merged.json()).id, targetId);
    assert.equal(repo.searchPapers().length, 1);
    assert.equal(repo.getDraft(draftId).status, "merged");
    assert.equal(repo.listBackupRecords().length, 1);

    const repeated = await fetch(`${baseUrl}/api/drafts/${draftId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetPaperId: targetId, confirm: true })
    });
    assert.equal(repeated.status, 409);
  });
});

test("API stores same-name same-millisecond uploads separately with correct hashes", async () => {
  await withServer(
    async (baseUrl, { dbPath, filesDir }) => {
      const firstBody = "%PDF-1.4\nfirst upload\n%%EOF";
      const secondBody = "%PDF-1.4\nsecond upload\n%%EOF";
      const form = new FormData();
      form.append("files", new Blob([firstBody], { type: "application/pdf" }), "same-name.pdf");
      form.append("files", new Blob([secondBody], { type: "application/pdf" }), "same-name.pdf");

      const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      assert.equal(response.status, 201);
      const drafts = await response.json();
      assert.equal(drafts.length, 2);
      assert.equal("storedPath" in drafts[0], false);
      assert.equal("fileSha256" in drafts[0], false);

      const db = openDb(dbPath);
      let rows;
      try {
        rows = db.prepare(
          "SELECT stored_path, file_sha256 FROM drafts ORDER BY id ASC"
        ).all();
      } finally {
        db.close();
      }
      assert.equal(new Set(rows.map((row) => row.stored_path)).size, 2);
      assert.deepEqual(rows.map((row) => row.file_sha256), [
        fingerprintBuffer(Buffer.from(firstBody)),
        fingerprintBuffer(Buffer.from(secondBody))
      ]);
      assert.deepEqual((await readdir(path.join(filesDir, String(new Date().getFullYear())))).sort(),
        rows.map((row) => path.basename(row.stored_path)).sort());
      assert.deepEqual(await Promise.all(rows.map((row) => readFile(path.resolve(row.stored_path)))), [
        Buffer.from(firstBody),
        Buffer.from(secondBody)
      ]);
    },
    {
      enableUploadLookup: false,
      now: () => 1_700_000_000_000,
      extractPdfText: async (filePath) => `Same-name upload ${path.basename(filePath)}`
    }
  );
});

test("API compensates every upload artifact when a later file fails", async () => {
  await withServer(
    async (baseUrl, { dbPath, filesDir, dir }) => {
      const db = openDb(dbPath);
      try {
        db.exec(`
          CREATE TRIGGER reject_second_upload BEFORE INSERT ON drafts
          WHEN NEW.original_filename = 'second.pdf'
          BEGIN SELECT RAISE(ABORT, 'second upload failed'); END;
        `);
      } finally {
        db.close();
      }

      const form = new FormData();
      form.append("files", new Blob(["%PDF-1.4\nfirst\n%%EOF"], { type: "application/pdf" }), "first.pdf");
      form.append("files", new Blob(["%PDF-1.4\nsecond\n%%EOF"], { type: "application/pdf" }), "second.pdf");

      const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      const body = await response.json();
      assert.equal(response.status, 500);
      assert.deepEqual(body, { error: "服务器内部错误" });
      assert.equal(JSON.stringify(body).includes(dir), false);

      const afterFailure = openDb(dbPath);
      try {
        assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM drafts").get().count, 0);
        assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM paper_files").get().count, 0);
      } finally {
        afterFailure.close();
      }
      const yearDir = path.join(filesDir, String(new Date().getFullYear()));
      assert.deepEqual(await readdir(yearDir), []);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => "Upload paper"
    }
  );
});

test("API sanitizes unknown global errors", async () => {
  await withServer(async (baseUrl, { dbPath, dir }) => {
    const db = openDb(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER leak_error BEFORE INSERT ON drafts
        BEGIN SELECT RAISE(ABORT, 'database failure at ${dir.replaceAll("'", "''")}\\private.sqlite'); END;
      `);
    } finally {
      db.close();
    }

    const response = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "error.txt", text: "Trigger error" })
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: "服务器内部错误" });
    assert.equal(JSON.stringify(body).includes(dir), false);
  });
});

test("API edits confirmed paper metadata and notes with conflict protection", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "edit.pdf", text: "Original paper title\nAbstract\nEdit test." })
    });
    const draft = await createResponse.json();
    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Original title" })
    });
    const paper = await confirmResponse.json();

    const noopResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: paper.version })
    });
    assert.equal(noopResponse.status, 400);
    const papersAfterNoop = await (await fetch(`${baseUrl}/api/papers`)).json();
    const unchanged = papersAfterNoop.find((item) => item.id === paper.id);
    assert.equal(unchanged.version, paper.version);
    assert.equal(unchanged.updatedAt, paper.updatedAt);

    const emptyNotesResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/notes`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: paper.version })
    });
    assert.equal(emptyNotesResponse.status, 400);
    const papersAfterEmptyNotes = await (await fetch(`${baseUrl}/api/papers`)).json();
    const unchangedAfterEmptyNotes = papersAfterEmptyNotes.find((item) => item.id === paper.id);
    assert.equal(unchangedAfterEmptyNotes.version, paper.version);
    assert.equal(unchangedAfterEmptyNotes.updatedAt, paper.updatedAt);

    const editResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        title: "Edited title",
        version: 99,
        storedPath: "outside/library.pdf",
        fileSha256: "mutated",
        deletedAt: "2026-01-01",
        mergedIntoId: 42
      })
    });
    assert.equal(editResponse.status, 200);
    const edited = await editResponse.json();
    assert.equal(edited.version, 2);
    assert.equal(edited.title, "Edited title");
    assert.equal("storedPath" in edited, false);
    assert.equal("fileSha256" in edited, false);
    assert.equal(edited.deletedAt, null);
    assert.equal(edited.mergedIntoId, null);

    const staleResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, title: "Stale title" })
    });
    assert.equal(staleResponse.status, 409);

    const notesResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/notes`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, notesPersonal: "Autosaved note", title: "Blocked" })
    });
    assert.equal(notesResponse.status, 200);
    const noted = await notesResponse.json();
    assert.equal(noted.notesPersonal, "Autosaved note");
    assert.equal(noted.title, "Edited title");
    assert.equal(noted.version, 3);
  });
});

test("API validates confirmed paper edits", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "validation.pdf", text: "Validation paper" })
    });
    const draft = await createResponse.json();
    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Validation paper" })
    });
    const paper = await confirmResponse.json();

    for (const body of [
      { expectedVersion: 0, title: "Invalid version" },
      { expectedVersion: 1, title: " " },
      { expectedVersion: 1, year: "2026" },
      { expectedVersion: 1, authors: "One Author" }
    ]) {
      const response = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
    }

    const missingResponse = await fetch(`${baseUrl}/api/papers/999999`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, title: "Missing" })
    });
    assert.equal(missingResponse.status, 404);
  });
});

test("API falls back to decoded filename when extracted PDF text is sparse", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "æ²³åå¹³åç¬¬åçºªå°è´¨æ¼åä¸ç¯å¢åè¿.pdf",
        text: "\n\n\n\n\n\n\n"
      })
    });

    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();
    assert.equal(draft.title, "河南平原第四纪地质演化与环境变迁");
    assert.deepEqual(draft.classification.regions, ["Henan Plain"]);
    assert.deepEqual(draft.classification.periods, ["Quaternary"]);
    assert.match(draft.abstract, /扫描版/);
  });
});

test("API enriches sparse uploaded PDF text with OCR output", async () => {
  let ocrCalled = false;

  await withServer(
    async (baseUrl) => {
      const form = new FormData();
      form.append("files", new Blob(["fake pdf"], { type: "application/pdf" }), "scan.pdf");

      const createResponse = await fetch(`${baseUrl}/api/uploads`, {
        method: "POST",
        body: form
      });

      assert.equal(createResponse.status, 201);
      const [draft] = await createResponse.json();
      assert.equal(ocrCalled, true);
      assert.equal(draft.title, "Late Quaternary evolution of the Henan Plain");
      assert.ok(draft.classification.regions.includes("Henan Plain"));
      assert.ok(draft.extractedText.includes("optical character recognition"));
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => "\n\n\n",
      extractOcrText: async () => {
        ocrCalled = true;
        return {
          used: true,
          reason: "",
          pages: 1,
          text: `
            Late Quaternary evolution of the Henan Plain
            Abstract
            This scanned paper uses optical character recognition to identify Quaternary
            geological evolution in the Henan Plain from regional sediment records.
            Keywords: Quaternary; Henan Plain; OCR
            Introduction
          `
        };
      }
    }
  );
});

test("API prefers OCR text when PDF text extraction fails", async () => {
  await withServer(
    async (baseUrl) => {
      const form = new FormData();
      form.append("files", new Blob(["fake pdf"], { type: "application/pdf" }), "scan.pdf");

      const createResponse = await fetch(`${baseUrl}/api/uploads`, {
        method: "POST",
        body: form
      });

      assert.equal(createResponse.status, 201);
      const [draft] = await createResponse.json();
      assert.equal(draft.title, "Scanned Quaternary record from the Yellow River Basin");
      assert.notEqual(draft.title, "PDF text extraction failed: invalid pdf");
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => {
        throw new Error("invalid pdf");
      },
      extractOcrText: async () => ({
        used: true,
        reason: "",
        pages: 1,
        text: `
          Scanned Quaternary record from the Yellow River Basin
          Abstract
          Optical character recognition recovered enough text for metadata parsing.
          Keywords: Quaternary; Yellow River basin
          Introduction
        `
      })
    }
  );
});

test("API serves the source PDF for a confirmed paper", async () => {
  await withServer(
    async (baseUrl) => {
      const pdfBody = "%PDF-1.4\nsource file\n%%EOF";
      const form = new FormData();
      form.append("files", new Blob([pdfBody], { type: "application/pdf" }), "source.pdf");

      const uploadResponse = await fetch(`${baseUrl}/api/uploads`, {
        method: "POST",
        body: form
      });
      assert.equal(uploadResponse.status, 201);
      const [draft] = await uploadResponse.json();

      const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: draft.title })
      });
      assert.equal(confirmResponse.status, 201);
      const paper = await confirmResponse.json();

      const fileResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/file`);
      assert.equal(fileResponse.status, 200);
      assert.match(fileResponse.headers.get("content-type"), /^application\/pdf/);
      assert.equal(await fileResponse.text(), pdfBody);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => `
        Source PDF test paper
        Abstract
        This paper tests source file reading in the Quaternary paper library.
        Keywords: Quaternary
        Introduction
      `
    }
  );
});

test("API returns 404 when a confirmed paper has no source file", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "paper.txt",
        text: "Paper without source file\nAbstract\nThis record has metadata but no PDF file."
      })
    });
    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();

    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: draft.title })
    });
    assert.equal(confirmResponse.status, 201);
    const paper = await confirmResponse.json();

    const fileResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/file`);
    assert.equal(fileResponse.status, 404);
  });
});

test("API sanitizes PDF extractor errors before storing or returning draft text", async () => {
  const absolutePath = path.join(os.tmpdir(), "qpl-private", "failed-extraction.pdf");
  await withServer(
    async (baseUrl, { dbPath, dir }) => {
      const form = new FormData();
      form.append("files", new Blob(["fake pdf"], { type: "application/pdf" }), "failed.pdf");

      const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      assert.equal(response.status, 201);
      const [draft] = await response.json();
      assert.equal(draft.extractedText.includes(absolutePath), false);
      assert.equal(JSON.stringify(draft).includes(dir), false);

      const db = openDb(dbPath);
      try {
        const row = db.prepare("SELECT extracted_text FROM drafts WHERE id = ?").get(draft.id);
        assert.equal(row.extracted_text.includes(absolutePath), false);
      } finally {
        db.close();
      }
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => {
        throw new Error(`cannot read ${absolutePath}`);
      },
      extractOcrText: async () => ({ text: "" })
    }
  );
});

test("API detects exact and DOI duplicates while allowing separate confirmation", async () => {
  await withServer(
    async (baseUrl) => {
      const upload = async (bytes, filename) => {
        const form = new FormData();
        form.append("files", new Blob([bytes], { type: "application/pdf" }), filename);
        const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
        assert.equal(response.status, 201);
        return (await response.json())[0];
      };

      const first = await upload("%PDF-1.4\nfirst\n%%EOF", "first.pdf");
      const firstConfirm = await fetch(`${baseUrl}/api/drafts/${first.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: first.title })
      });
      assert.equal(firstConfirm.status, 201);

      const sameBytes = await upload("%PDF-1.4\nfirst\n%%EOF", "same.pdf");
      assert.equal(sameBytes.duplicateCandidates[0].reason, "sha256");
      assert.equal(sameBytes.duplicateCandidates[0].score, 1);
      const sameConfirm = await fetch(`${baseUrl}/api/drafts/${sameBytes.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: sameBytes.title })
      });
      assert.equal(sameConfirm.status, 201);

      const differentBytes = await upload("%PDF-1.4\nsecond\n%%EOF", "different.pdf");
      assert.equal(differentBytes.duplicateCandidates[0].reason, "doi");
      assert.equal(differentBytes.duplicateCandidates[0].score, 1);

      const papers = await (await fetch(`${baseUrl}/api/papers`)).json();
      assert.equal(papers.length, 2);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => `
        Holocene lake sediment record
        DOI: 10.1000/duplicate.
        Abstract
        A duplicate detection test paper.
        Year: 2020
      `
    }
  );
});

test("API scans only safe active PDF files and returns duplicate groups", async () => {
  await withServer(async (baseUrl, { dbPath, filesDir, dir }) => {
    const insidePath = path.join(filesDir, "2026", "scan.pdf");
    const outsidePath = path.join(dir, "outside.pdf");
    await mkdir(path.dirname(insidePath), { recursive: true });
    await writeFile(insidePath, "%PDF-1.4\nscan\n%%EOF");
    await writeFile(outsidePath, "%PDF-1.4\noutside\n%%EOF");

    const repo = new PaperRepository(dbPath);
    const insideDraft = repo.createDraft({
      storedPath: insidePath,
      storedFilename: "scan.pdf",
      doi: "10.1000/scan",
      title: "Scanned paper",
      year: 2020,
      classification: {},
      confidence: {},
      evidence: {}
    });
    const outsideDraft = repo.createDraft({
      storedPath: outsidePath,
      storedFilename: "outside.pdf",
      doi: "10.1000/outside",
      title: "Outside paper",
      year: 2020,
      classification: {},
      confidence: {},
      evidence: {}
    });
    const insidePaperId = repo.confirmDraft(insideDraft);
    const outsidePaperId = repo.confirmDraft(outsideDraft);

    const scanResponse = await fetch(`${baseUrl}/api/duplicates/scan`, { method: "POST" });
    assert.equal(scanResponse.status, 200);
    const scan = await scanResponse.json();
    assert.ok(scan.scanned.includes("2026/scan.pdf"));
    assert.equal(scan.rejected.length, 1);
    assert.equal(JSON.stringify(scan).includes(dir), false);
    assert.equal(scan.groups.sha256.length, 0);

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare("SELECT file_sha256 FROM papers WHERE id = ?").get(insidePaperId).file_sha256,
        "cc446fe332e4e71dc69b9a448bfdebd952ec396489a6edebe4665eea448ad985");
      assert.equal(db.prepare("SELECT file_sha256 FROM papers WHERE id = ?").get(outsidePaperId).file_sha256, "");
    } finally {
      db.close();
    }

    const latestResponse = await fetch(`${baseUrl}/api/duplicates`);
    assert.equal(latestResponse.status, 200);
    const latest = await latestResponse.json();
    assert.deepEqual(latest.groups, scan.groups);
  });
});

test("API abandons only confirmed pending draft deletions and cleans safe files", async () => {
  await withServer(async (baseUrl, { filesDir }) => {
    const storedPath = path.join(filesDir, "2026", "abandon.pdf");
    await mkdir(path.dirname(storedPath), { recursive: true });
    await writeFile(storedPath, "%PDF-1.4\nabandon\n%%EOF");

    const repo = new PaperRepository(path.join(path.dirname(filesDir), "library.sqlite"));
    const pendingId = repo.createDraft({ storedPath, storedFilename: "abandon.pdf", title: "Abandon me" });
    const confirmedId = repo.createDraft({ title: "Keep me" });
    repo.confirmDraft(confirmedId);

    const missingConfirm = await fetch(`${baseUrl}/api/drafts/${pendingId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(missingConfirm.status, 400);

    const deleted = await fetch(`${baseUrl}/api/drafts/${pendingId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(deleted.status, 200);
    await assert.rejects(access(storedPath));

    const protectedDelete = await fetch(`${baseUrl}/api/drafts/${confirmedId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(protectedDelete.status, 409);
  });
});

test("GET duplicates groups active secondary hashes into one deterministic group", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const createPaper = (fileSha256, title) => repo.confirmDraft(repo.createDraft({
      fileSha256,
      title,
      classification: {},
      confidence: {},
      evidence: {}
    }));
    const firstPaperId = createPaper("representative-first", "First paper");
    const secondPaperId = createPaper("representative-second", "Second paper");

    const db = openDb(dbPath);
    try {
      const insertFile = db.prepare(`
        INSERT INTO paper_files (paper_id, stored_filename, stored_path, sha256, status)
        VALUES (?, ?, ?, ?, ?)
      `);
      insertFile.run(firstPaperId, "first-secondary.pdf", "2026/first-secondary.pdf", "shared-hash", "active");
      insertFile.run(firstPaperId, "first-secondary-copy.pdf", "2026/first-secondary-copy.pdf", "shared-hash", "active");
      insertFile.run(secondPaperId, "second-secondary.pdf", "2026/second-secondary.pdf", "shared-hash", "active");
      insertFile.run(secondPaperId, "second-trash.pdf", "2026/second-trash.pdf", "shared-hash", "trash");
    } finally {
      db.close();
    }

    const response = await fetch(`${baseUrl}/api/duplicates`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.groups.sha256, [
      { sha256: "shared-hash", paperIds: [firstPaperId, secondPaperId] }
    ]);
  });
});

test("API trashes, restores, and purges a paper with explicit confirmation", async () => {
  await withServer(
    async (baseUrl) => {
      const pdfBody = "%PDF-1.4\nrecycle bin source\n%%EOF";
      const form = new FormData();
      form.append("files", new Blob([pdfBody], { type: "application/pdf" }), "recycle.pdf");
      const uploadResponse = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      assert.equal(uploadResponse.status, 201);
      const [draft] = await uploadResponse.json();

      const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: draft.title })
      });
      const paper = await confirmResponse.json();

      assert.equal((await fetch(`${baseUrl}/api/papers/999999`, { method: "DELETE" })).status, 404);
      const trashResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, { method: "DELETE" });
      assert.equal(trashResponse.status, 200);
      assert.equal((await (await fetch(`${baseUrl}/api/papers`)).json()).length, 0);
      assert.equal((await (await fetch(`${baseUrl}/api/trash`)).json())[0].id, paper.id);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 200);

      const missingConfirm = await fetch(`${baseUrl}/api/trash/${paper.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(missingConfirm.status, 400);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 200);

      assert.equal((await fetch(`${baseUrl}/api/trash/999999/restore`, { method: "POST" })).status, 404);
      const restoreResponse = await fetch(`${baseUrl}/api/trash/${paper.id}/restore`, { method: "POST" });
      assert.equal(restoreResponse.status, 200);
      assert.equal((await (await fetch(`${baseUrl}/api/papers`)).json())[0].id, paper.id);

      await fetch(`${baseUrl}/api/papers/${paper.id}`, { method: "DELETE" });
      const purgeResponse = await fetch(`${baseUrl}/api/trash/${paper.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(purgeResponse.status, 200);
      const purgeBody = await purgeResponse.json();
      assert.ok(purgeBody.cleanup);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/trash/${paper.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      })).status, 404);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => "Recycle bin source paper\nAbstract\nA source file for recycle bin tests."
    }
  );
});

test("API purges every trashed paper only after full-bin confirmation", async () => {
  await withServer(
    async (baseUrl) => {
      const form = new FormData();
      form.append("files", new Blob(["%PDF-1.4\nfull bin\n%%EOF"], { type: "application/pdf" }), "full-bin.pdf");
      const uploadResponse = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      const [draft] = await uploadResponse.json();
      const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: draft.title })
      });
      const paper = await confirmResponse.json();
      await fetch(`${baseUrl}/api/papers/${paper.id}`, { method: "DELETE" });

      const missingConfirm = await fetch(`${baseUrl}/api/trash`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(missingConfirm.status, 400);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 200);

      const purgeResponse = await fetch(`${baseUrl}/api/trash`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(purgeResponse.status, 200);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 404);
      assert.deepEqual(await (await fetch(`${baseUrl}/api/trash`)).json(), []);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => "Full bin source paper\nAbstract\nA source file for full-bin purge tests."
    }
  );
});

test("API rejects symlink or junction traversal for reads and purge", async () => {
  await withServer(async (baseUrl, { dbPath, dir, filesDir }) => {
    const outsideDir = path.join(dir, "outside");
    const linkedDir = path.join(filesDir, "linked");
    const victimPath = path.join(outsideDir, "victim.pdf");
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    await writeFile(victimPath, "%PDF-1.4 outside victim");

    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({
      storedPath: path.join(linkedDir, "victim.pdf"),
      storedFilename: "victim.pdf",
      title: "Linked victim paper",
      classification: {},
      confidence: {},
      evidence: {}
    });
    const paperId = repo.confirmDraft(draftId);

    assert.equal((await fetch(`${baseUrl}/api/papers/${paperId}/file`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/papers/${paperId}`, { method: "DELETE" })).status, 200);
    const purgeResponse = await fetch(`${baseUrl}/api/trash/${paperId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(purgeResponse.status, 200);
    const purgeBody = await purgeResponse.json();
    assert.deepEqual(purgeBody.cleanup.removed, []);
    assert.equal(purgeBody.cleanup.rejected.length, 1);
    assert.ok(!JSON.stringify(purgeBody).includes(filesDir));
    await access(victimPath);
  });
});

test("Task 4 responses omit absolute and internal paper storage fields", async () => {
  await withServer(async (baseUrl, { dbPath, dir }) => {
    const absoluteStoredPath = path.join(dir, "private", "absolute.pdf");
    const secondStoredPath = path.join(dir, "private", "second.pdf");
    const repo = new PaperRepository(dbPath);

    const createPaper = (storedPath, title) => {
      const draftId = repo.createDraft({
        storedPath,
        storedFilename: path.basename(storedPath),
        fileSha256: "private-hash",
        title,
        year: 2026,
        classification: {},
        confidence: {},
        evidence: {}
      });
      return repo.confirmDraft(draftId);
    };
    const firstPaperId = createPaper(absoluteStoredPath, "Private path paper");
    const secondPaperId = createPaper(secondStoredPath, "Second private path paper");
    const publicKeys = ["deletedAt", "id", "status", "title", "version", "year"].sort();

    const assertPublicPaperBody = (body, expectedStatus) => {
      assert.deepEqual(Object.keys(body).sort(), publicKeys);
      assert.equal(body.status, expectedStatus);
      assert.equal(JSON.stringify(body).includes(absoluteStoredPath), false);
      return body;
    };
    const assertPublicPaper = async (response, expectedStatus) => {
      assert.equal(response.status, 200);
      return assertPublicPaperBody(await response.json(), expectedStatus);
    };

    await assertPublicPaper(
      await fetch(`${baseUrl}/api/papers/${firstPaperId}`, { method: "DELETE" }),
      "trash"
    );
    await assertPublicPaper(
      await fetch(`${baseUrl}/api/papers/${secondPaperId}`, { method: "DELETE" }),
      "trash"
    );

    const trashResponse = await fetch(`${baseUrl}/api/trash`);
    assert.equal(trashResponse.status, 200);
    const trashPapers = await trashResponse.json();
    assert.equal(trashPapers.length, 2);
    for (const paper of trashPapers) {
      assert.deepEqual(Object.keys(paper).sort(), publicKeys);
      assert.equal(paper.status, "trash");
      assert.equal(JSON.stringify(paper).includes(absoluteStoredPath), false);
    }

    await assertPublicPaper(
      await fetch(`${baseUrl}/api/trash/${firstPaperId}/restore`, { method: "POST" }),
      "active"
    );
    await assertPublicPaper(
      await fetch(`${baseUrl}/api/papers/${firstPaperId}`, { method: "DELETE" }),
      "trash"
    );

    const individualPurgeResponse = await fetch(`${baseUrl}/api/trash/${firstPaperId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(individualPurgeResponse.status, 200);
    const individualPurgeBody = await individualPurgeResponse.json();
    assertPublicPaperBody(individualPurgeBody.paper, "trash");
    assert.equal(JSON.stringify(individualPurgeBody).includes(absoluteStoredPath), false);

    const fullPurgeResponse = await fetch(`${baseUrl}/api/trash`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(fullPurgeResponse.status, 200);
    const fullPurgeBody = await fullPurgeResponse.json();
    assert.equal(fullPurgeBody.papers.length, 1);
    assert.deepEqual(Object.keys(fullPurgeBody.papers[0]).sort(), publicKeys);
    assert.equal(fullPurgeBody.papers[0].status, "trash");
    assert.equal(JSON.stringify(fullPurgeBody).includes(absoluteStoredPath), false);
  });
});

test("API returns 409 when editing trashed or merged papers", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const createPaper = (title) => {
      const draftId = repo.createDraft({ title, classification: {}, confidence: {}, evidence: {} });
      return repo.confirmDraft(draftId);
    };
    const trashedId = createPaper("Trashed API paper");
    assert.equal((await fetch(`${baseUrl}/api/papers/${trashedId}`, { method: "DELETE" })).status, 200);

    const trashedEdit = await fetch(`${baseUrl}/api/papers/${trashedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, title: "Blocked" })
    });
    assert.equal(trashedEdit.status, 409);
    assert.match((await trashedEdit.json()).error, /active before editing/);

    const trashedProgress = await fetch(`${baseUrl}/api/papers/${trashedId}/reading-progress`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastReadPage: 2 })
    });
    assert.equal(trashedProgress.status, 409);
    assert.match((await trashedProgress.json()).error, /active before updating reading progress/);

    const mergedId = createPaper("Merged API paper");
    const db = openDb(dbPath);
    try {
      db.prepare("UPDATE papers SET deleted_at = CURRENT_TIMESTAMP, merged_into_id = 999 WHERE id = ?").run(mergedId);
    } finally {
      db.close();
    }

    const mergedEdit = await fetch(`${baseUrl}/api/papers/${mergedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, title: "Blocked merged edit" })
    });
    assert.equal(mergedEdit.status, 409);
    assert.match((await mergedEdit.json()).error, /active before editing/);

    const mergedPurge = await fetch(`${baseUrl}/api/trash/${mergedId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(mergedPurge.status, 409);
    assert.match((await mergedPurge.json()).error, /cannot be purged/);

    const mergedFullPurge = await fetch(`${baseUrl}/api/trash`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(mergedFullPurge.status, 409);
    assert.match((await mergedFullPurge.json()).error, /cannot be purged/);
  });
});

test("API saves reading progress and exposes it in paper list", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "reader.pdf",
        text: "Reader progress paper\nAbstract\nThis record tests reader bookmarks."
      })
    });
    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();

    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: draft.title })
    });
    assert.equal(confirmResponse.status, 201);
    const paper = await confirmResponse.json();

    const lastReadResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/reading-progress`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastReadPage: 4 })
    });
    assert.equal(lastReadResponse.status, 200);
    let updated = await lastReadResponse.json();
    assert.equal(updated.lastReadPage, 4);
    assert.equal(updated.bookmarkPage, null);

    const bookmarkResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/reading-progress`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkPage: 7 })
    });
    assert.equal(bookmarkResponse.status, 200);
    updated = await bookmarkResponse.json();
    assert.equal(updated.lastReadPage, 4);
    assert.equal(updated.bookmarkPage, 7);

    const listResponse = await fetch(`${baseUrl}/api/papers`);
    const papers = await listResponse.json();
    assert.equal(papers[0].lastReadPage, 4);
    assert.equal(papers[0].bookmarkPage, 7);
  });
});

test("API translation is disabled unless explicitly enabled", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /翻译功能未启用/);
    },
    { translationEnabled: false }
  );
});

test("API translation requires an OpenAI API key", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /OPENAI_API_KEY/);
    },
    { translationEnabled: true, openaiApiKey: "" }
  );
});

test("API Gemini translation requires a Gemini API key", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /GEMINI_API_KEY/);
    },
    { translationEnabled: true, translationProvider: "gemini", geminiApiKey: "" }
  );
});

test("API Qwen translation requires a Qwen API key", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /QWEN_API_KEY/);
    },
    { translationEnabled: true, translationProvider: "qwen", qwenApiKey: "" }
  );
});

test("API translation returns provider result", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "The loess-paleosol sequence records river integration.",
          targetLanguage: "zh-CN"
        })
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.translatedText, "黄土-古土壤序列记录了河流贯通过程。");
      assert.equal(body.provider, "openai");
    },
    {
      translationEnabled: true,
      openaiApiKey: "test-key",
      translationModel: "test-model",
      translationFetch: async (url, options) => {
        assert.equal(url, "https://api.openai.com/v1/responses");
        assert.equal(options.method, "POST");
        assert.equal(options.headers.authorization, "Bearer test-key");
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, "test-model");
        assert.match(JSON.stringify(payload.input), /loess-paleosol/);
        return new Response(JSON.stringify({ output_text: "黄土-古土壤序列记录了河流贯通过程。" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
  );
});

test("API Gemini translation returns provider result", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "The loess-paleosol sequence records river integration.",
          targetLanguage: "zh-CN"
        })
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.translatedText, "黄土-古土壤序列记录了河流贯通过程。");
      assert.equal(body.provider, "gemini");
    },
    {
      translationEnabled: true,
      translationProvider: "gemini",
      geminiApiKey: "test-gemini-key",
      geminiModel: "gemini-test-model",
      translationFetch: async (url, options) => {
        assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent");
        assert.equal(options.method, "POST");
        assert.equal(options.headers["x-goog-api-key"], "test-gemini-key");
        const payload = JSON.parse(options.body);
        assert.match(payload.contents[0].parts[0].text, /loess-paleosol/);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "黄土-古土壤序列记录了河流贯通过程。" }]
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
    }
  );
});

test("API Qwen translation returns provider result", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "The loess-paleosol sequence records river integration.",
          targetLanguage: "zh-CN"
        })
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.translatedText, "Qwen provider translation");
      assert.equal(body.provider, "qwen");
    },
    {
      translationEnabled: true,
      translationProvider: "qwen",
      qwenApiKey: "test-qwen-key",
      qwenModel: "qwen-test-model",
      qwenBaseUrl: "https://example.aliyuncs.com/compatible-mode/v1",
      translationFetch: async (url, options) => {
        assert.equal(url, "https://example.aliyuncs.com/compatible-mode/v1/chat/completions");
        assert.equal(options.method, "POST");
        assert.equal(options.headers.authorization, "Bearer test-qwen-key");
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, "qwen-test-model");
        assert.match(payload.messages[1].content, /loess-paleosol/);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Qwen provider translation" } }]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
    }
  );
});

test("API translation rejects empty selections", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "   " })
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /请先在 PDF 中选中文字/);
    },
    {
      translationEnabled: true,
      openaiApiKey: "test-key"
    }
  );
});

test("API translation rejects oversized selections", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(6001) })
      });

      assert.equal(response.status, 413);
      assert.match((await response.json()).error, /选中文本过长/);
    },
    {
      translationEnabled: true,
      openaiApiKey: "test-key",
      translationFetch: async () => {
        throw new Error("provider should not be called");
      }
    }
  );
});

test("API translation maps provider failures to a clear error", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /翻译服务暂时不可用/);
    },
    {
      translationEnabled: true,
      openaiApiKey: "test-key",
      translationFetch: async () =>
        new Response(JSON.stringify({ error: "provider unavailable" }), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
    }
  );
});
