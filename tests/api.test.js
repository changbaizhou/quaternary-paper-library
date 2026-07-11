import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createApp } from "../src/server.js";

async function withServer(callback, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-api-"));
  const app = createApp({
    dbPath: path.join(dir, "library.sqlite"),
    filesDir: path.join(dir, "files"),
    staticDir: path.resolve("public"),
    ...overrides
  });
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await callback(baseUrl);
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
    assert.equal(edited.storedPath, paper.storedPath);
    assert.equal(edited.fileSha256, paper.fileSha256);
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
