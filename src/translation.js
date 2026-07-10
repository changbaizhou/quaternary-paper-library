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

export async function translateText(input = {}, options = {}) {
  const enabled = options.enabled === true;
  const text = normalizeText(input.text);
  const targetLanguage = input.targetLanguage || "zh-CN";

  if (!enabled) throw new TranslationError(503, "翻译功能未启用，请设置 QPL_TRANSLATION_ENABLED=1");
  if (!options.apiKey) throw new TranslationError(503, "未配置 OPENAI_API_KEY，无法使用在线翻译");
  if (!text) throw new TranslationError(400, "请先在 PDF 中选中文字");
  if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
    throw new TranslationError(413, "选中文本过长，请缩短后再翻译");
  }

  const endpoint = options.endpoint || "https://api.openai.com/v1/responses";
  const model = options.model || "gpt-4o-mini";
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(endpoint, {
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

  if (!response.ok) throw new TranslationError(502, "翻译服务暂时不可用");

  const payload = await response.json().catch(() => ({}));
  const translatedText = extractResponseText(payload);
  if (!translatedText) throw new TranslationError(502, "翻译服务暂时不可用");

  return { translatedText, provider: "openai", model };
}
