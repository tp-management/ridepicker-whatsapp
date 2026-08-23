export const MAX_ASSIST_KEYWORDS = 50;
export const MAX_ASSIST_KEYWORD_LENGTH = 80;

const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF]/g;
const WHITESPACE_PATTERN = /\s+/gu;

export function normalizeAssistText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH_PATTERN, "")
    .replace(WHITESPACE_PATTERN, " ")
    .trim()
    .toLowerCase();
}

function cleanKeyword(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH_PATTERN, "")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function sanitizeAssistKeywords(value) {
  if (!Array.isArray(value)) {
    throw badRequest("keywords must be an array");
  }

  if (value.length > MAX_ASSIST_KEYWORDS) {
    throw badRequest(`A maximum of ${MAX_ASSIST_KEYWORDS} keywords is allowed`);
  }

  const result = [];
  const seen = new Set();

  for (const raw of value) {
    if (typeof raw !== "string") {
      throw badRequest("each keyword must be a string");
    }

    const keyword = cleanKeyword(raw);
    if (!keyword) {
      throw badRequest("keywords cannot be empty");
    }
    if (keyword.length > MAX_ASSIST_KEYWORD_LENGTH) {
      throw badRequest(
        `each keyword must be ${MAX_ASSIST_KEYWORD_LENGTH} characters or fewer`
      );
    }

    const normalized = normalizeAssistText(keyword);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(keyword);
  }

  return result;
}

export function messageMatchesAssistKeywords(message, keywords) {
  const normalizedKeywords = Array.isArray(keywords)
    ? keywords.map(normalizeAssistText).filter(Boolean)
    : [];

  if (!normalizedKeywords.length) {
    return true;
  }

  const normalizedMessage = normalizeAssistText(message);
  if (!normalizedMessage) {
    return false;
  }

  return normalizedKeywords.some((keyword) => normalizedMessage.includes(keyword));
}
