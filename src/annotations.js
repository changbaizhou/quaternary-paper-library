const ANNOTATION_KINDS = new Set(["highlight", "note", "quote"]);
const ANNOTATION_COLORS = new Set(["yellow", "green", "blue", "pink", "purple"]);
const EVIDENCE_TYPES = new Set(["supports", "opposes", "method", "background", "uncertain"]);
const MAX_QUOTE_LENGTH = 20_000;
const MAX_TEXT_LENGTH = 20_000;

function textValue(value, field, { required = false, maxLength = MAX_TEXT_LENGTH } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  if (value.length > maxLength) throw new RangeError(`${field} is too long`);
  if (/<\/?[a-z][^>]*>/i.test(value)) throw new TypeError(`${field} must be plain text`);
  return value;
}

function integerValue(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

export function normalizeTextSelector(input = {}) {
  const quote = textValue(input.quote, "quote", { required: true, maxLength: MAX_QUOTE_LENGTH });
  if (!quote.trim()) throw new TypeError("quote is required");
  const prefix = textValue(input.prefix, "prefix", { maxLength: 32 });
  const suffix = textValue(input.suffix, "suffix", { maxLength: 32 });
  const hasStart = input.start !== undefined && input.start !== null;
  const hasEnd = input.end !== undefined && input.end !== null;
  if (hasStart !== hasEnd) throw new TypeError("start and end must be provided as a pair");

  let start;
  let end;
  if (hasStart) {
    start = integerValue(input.start, "start");
    end = integerValue(input.end, "end");
    if (end <= start) throw new TypeError("end must be greater than start");
  }

  let positionVerified = input.positionVerified === true;
  if (typeof input.positionVerified !== "undefined" && typeof input.positionVerified !== "boolean") {
    throw new TypeError("positionVerified must be boolean");
  }
  const pageText = typeof input.pageText === "string" ? input.pageText : input.paperPageText;
  if (hasStart && typeof pageText === "string") {
    positionVerified = pageText.slice(start, end) === quote;
  } else if (!hasStart) {
    positionVerified = false;
  }

  const selector = { quote, prefix, suffix };
  if (hasStart) {
    selector.start = start;
    selector.end = end;
  }
  selector.positionVerified = positionVerified;
  return selector;
}

export function validateAnnotationKind(kind) {
  if (!ANNOTATION_KINDS.has(kind)) throw new TypeError("kind must be highlight, note, or quote");
  return kind;
}

export function validateAnnotationColor(color) {
  if (color === undefined || color === null || color === "") return "yellow";
  if (typeof color !== "string" || (!ANNOTATION_COLORS.has(color) && !/^#[0-9a-f]{6}$/i.test(color))) {
    throw new TypeError("color is invalid");
  }
  return color;
}

export function validateEvidenceType(evidenceType) {
  if (!EVIDENCE_TYPES.has(evidenceType)) {
    throw new TypeError("evidenceType is invalid");
  }
  return evidenceType;
}

export function normalizeThemes(themes) {
  if (themes === undefined || themes === null) return [];
  if (!Array.isArray(themes) || themes.some((theme) => typeof theme !== "string")) {
    throw new TypeError("themes must be an array of strings");
  }
  return themes.map((theme) => textValue(theme.trim(), "theme", { maxLength: 80 }))
    .filter(Boolean)
    .slice(0, 32);
}

export function validateAnnotationInput(input = {}) {
  const quoteText = textValue(input.quoteText ?? input.quote, "quoteText", {
    required: true,
    maxLength: MAX_QUOTE_LENGTH
  });
  if (!quoteText.trim()) throw new TypeError("quoteText is required");
  return {
    kind: validateAnnotationKind(input.kind),
    color: validateAnnotationColor(input.color),
    quoteText,
    translatedText: textValue(input.translatedText, "translatedText"),
    comment: textValue(input.comment, "comment"),
    textSelector: normalizeTextSelector(input.textSelector || {
      quote: quoteText,
      prefix: input.prefix,
      suffix: input.suffix,
      start: input.start,
      end: input.end,
      positionVerified: input.positionVerified,
      pageText: input.pageText
    })
  };
}

export function validateResearchCardInput(input = {}) {
  return {
    quoteText: textValue(input.quoteText, "quoteText", { required: true, maxLength: MAX_QUOTE_LENGTH }),
    translatedText: textValue(input.translatedText, "translatedText"),
    summary: textValue(input.summary, "summary"),
    personalInterpretation: textValue(input.personalInterpretation, "personalInterpretation"),
    themes: normalizeThemes(input.themes),
    evidenceType: validateEvidenceType(input.evidenceType || "uncertain")
  };
}

export { ANNOTATION_KINDS, ANNOTATION_COLORS, EVIDENCE_TYPES };
