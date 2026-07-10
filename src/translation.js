export const MAX_TRANSLATION_TEXT_LENGTH = 6000;

export class TranslationError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "TranslationError";
    this.status = status;
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();

  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (typeof part?.text === "string" && part.text.trim()) return part.text.trim();
    }
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) return part.text.trim();
    }
  }

  const choiceText = payload?.choices?.[0]?.message?.content;
  return typeof choiceText === "string" ? choiceText.trim() : "";
}

function translationPrompt(text, targetLanguage) {
  return `Translate the selected academic text into clear Simplified Chinese.
Preserve Quaternary geology terms, citations, numbers, units, sample codes, and geological time names.
Target language: ${targetLanguage}

Selected text:
${text}`;
}

async function translateWithOpenAI({ text, targetLanguage, options, fetchImpl }) {
  const endpoint = options.endpoint || "https://api.openai.com/v1/responses";
  const model = options.model || "gpt-4o-mini";
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content:
              "You are an academic translator for Quaternary geology papers. Translate the user's selected text into clear Simplified Chinese. Preserve technical terms, numbers, citations, units, and geological time names."
          },
          {
            role: "user",
            content: `Target language: ${targetLanguage}\n\nSelected text:\n${text}`
          }
        ]
      })
    });
  } catch {
    throw new TranslationError(502, "翻译服务暂时不可用");
  }

  if (!response.ok) throw new TranslationError(502, "翻译服务暂时不可用");

  const payload = await response.json().catch(() => ({}));
  const translatedText = extractResponseText(payload);
  if (!translatedText) throw new TranslationError(502, "翻译服务暂时不可用");

  return { translatedText, provider: "openai", model };
}

async function translateWithGemini({ text, targetLanguage, options, fetchImpl }) {
  const model = (options.geminiModel || "gemini-3.5-flash").replace(/^models\//, "");
  const endpoint =
    options.geminiEndpoint ||
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "x-goog-api-key": options.geminiApiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: translationPrompt(text, targetLanguage) }]
          }
        ],
        generationConfig: {
          temperature: 0.2
        }
      })
    });
  } catch {
    throw new TranslationError(502, "翻译服务暂时不可用");
  }

  if (!response.ok) throw new TranslationError(502, "翻译服务暂时不可用");

  const payload = await response.json().catch(() => ({}));
  const translatedText = extractResponseText(payload);
  if (!translatedText) throw new TranslationError(502, "翻译服务暂时不可用");

  return { translatedText, provider: "gemini", model };
}

export async function translateText(input = {}, options = {}) {
  const enabled = options.enabled === true;
  const provider = options.provider || "openai";
  const text = normalizeText(input.text);
  const targetLanguage = input.targetLanguage || "zh-CN";

  if (!enabled) throw new TranslationError(503, "翻译功能未启用，请设置 QPL_TRANSLATION_ENABLED=1");
  if (!text) throw new TranslationError(400, "请先在 PDF 中选中文字");
  if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
    throw new TranslationError(413, "选中文本过长，请缩短后再翻译");
  }

  const fetchImpl = options.fetchImpl || fetch;

  if (provider === "gemini") {
    if (!options.geminiApiKey) throw new TranslationError(503, "未配置 GEMINI_API_KEY，无法使用 Gemini 翻译");
    return translateWithGemini({ text, targetLanguage, options, fetchImpl });
  }

  if (!options.apiKey) throw new TranslationError(503, "未配置 OPENAI_API_KEY，无法使用在线翻译");
  return translateWithOpenAI({ text, targetLanguage, options, fetchImpl });
}
