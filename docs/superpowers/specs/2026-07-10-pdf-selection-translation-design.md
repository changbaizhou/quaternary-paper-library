# PDF Selection Translation Design

## Goal

Add an optional online translation feature to the PDF reader. When the user selects text in the rendered PDF text layer, the app should let them translate that selection into Chinese without leaving the reader.

## User Flow

1. The user opens a confirmed paper in the in-page PDF reader.
2. The user selects a paragraph or sentence from the PDF text layer.
3. A translation panel/button becomes available near the reader toolbar or below the toolbar.
4. The user clicks `翻译选中文本`.
5. The frontend sends the selected text to the backend.
6. The backend calls the configured online translation provider.
7. The translated Chinese text is shown in the reader panel.

The first version will not save selected source text or translated output to SQLite. Translation is a temporary reading aid, not a permanent note feature.

## Recommended Architecture

The frontend owns text selection and display state. It reads `window.getSelection()`, trims the text, blocks empty selections, and renders loading/error/result states in the reader.

The backend owns provider credentials. A new route `POST /api/translate` accepts JSON like:

```json
{
  "text": "Selected English text from the PDF.",
  "targetLanguage": "zh-CN"
}
```

It returns:

```json
{
  "translatedText": "PDF中选中英文内容的中文译文。",
  "provider": "openai"
}
```

## Provider

Use an OpenAI-compatible HTTP call first because it handles academic long sentences and field terminology better than dictionary-style translation APIs.

Configuration is via environment variables only:

- `QPL_TRANSLATION_ENABLED=1`
- `OPENAI_API_KEY`
- `QPL_TRANSLATION_MODEL`, default `gpt-4o-mini`

If `QPL_TRANSLATION_ENABLED` is not `1`, the backend returns a clear `503` JSON error. If `OPENAI_API_KEY` is missing, the backend returns a clear `503` JSON error. This prevents accidental network calls.

## Privacy And Safety

Only the selected text is sent to the translation provider. Full PDFs, stored files, database records, notes, and metadata are not uploaded by the translation route.

The backend should limit request size so accidental large selections do not send excessive content. The first version should cap selected text at 6000 characters.

## UI Behavior

The reader toolbar gains a compact `翻译选中` button. A small translation panel below the toolbar shows:

- selected text length or `未选择文本`
- loading state: `正在翻译`
- result text
- clear error messages, for example `未启用翻译` or `未配置 OPENAI_API_KEY`

The panel should not block scrolling or resizing. It should fit the existing quiet tool-style UI.

## Error Handling

- Empty selection: show `请先在PDF中选中文字`.
- Translation disabled: show backend message.
- Missing API key: show backend message.
- Provider/network failure: show `翻译服务暂时不可用`.
- Oversized selection: show `选中文本过长，请缩短后再翻译`.

## Tests

Add backend API tests for:

- disabled translation returns `503`
- missing API key returns `503`
- provider success returns translated text
- oversized selected text returns `413`

Add frontend structure tests for:

- translation button exists in the reader toolbar
- translation panel exists
- frontend calls `/api/translate`
- frontend reads selected text with `window.getSelection()`

## Out Of Scope

- Persistent translation history
- Bilingual paragraph alignment
- Batch full-paper translation
- Offline translation models
- Provider selection UI
