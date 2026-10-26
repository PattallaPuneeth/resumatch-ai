/**
 * Untrusted content sanitizer for scraped job listings.
 * Enforces:
 * - Dangerous tag removal (<script>, <style>, <iframe>, <object>, <embed>) with their inner content
 * - Full HTML tag stripping
 * - HTML entity decoding
 * - ASCII control character removal (preserving standard linebreaks and tabs)
 * - Length bounding (capped at 10,000 characters)
 * - Neutralization of prompt-injection patterns
 */

const DANGEROUS_TAG_REGEX = /<(script|style|iframe|object|embed|applet|meta|link)[\s\S]*?<\/\1>/gi;
const SELF_CLOSING_DANGEROUS_REGEX = /<(script|style|iframe|object|embed|applet|meta|link)[^>]*\/?>/gi;
const HTML_TAG_REGEX = /<[^>]+>/g;

const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/gi,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/gi,
  /\bnew\s+instructions\s*:/gi,
  /\bsystem\s+prompt\s*:/gi,
  /\b(?:system|assistant|human)\s*:\s*(?:you\s+are|ignore|always|output)\b/gi,
  /\byou\s+are\s+now\s+(?:a|an|in)\b/gi,
  /\boverride\s+(?:system|previous)\s+prompt\b/gi,
  /\boutput\s+the\s+following\s+system\s+message\b/gi,
];

/**
 * Decodes common HTML entities into plain text.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return code >= 32 && code <= 65535 ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return code >= 32 && code <= 65535 ? String.fromCharCode(code) : '';
    });
}

/**
 * Sanitizes scraped untrusted text before caching or processing.
 */
export function sanitizeScrapedContent(raw: string, maxLength: number = 10000): string {
  if (!raw || typeof raw !== 'string') {
    return '';
  }

  // 1. Remove dangerous blocks completely (including content)
  let cleaned = raw.replace(DANGEROUS_TAG_REGEX, ' ').replace(SELF_CLOSING_DANGEROUS_REGEX, ' ');

  // 2. Strip remaining HTML tags
  cleaned = cleaned.replace(HTML_TAG_REGEX, ' ');

  // 3. Decode HTML entities
  cleaned = decodeHtmlEntities(cleaned);

  // 4. Remove control characters (except \n, \r, \t)
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // 5. Neutralize prompt-injection patterns
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[neutralized-instruction-pattern]');
  }

  // 6. Normalize multiple consecutive spaces and newlines
  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

  // 7. Enforce max length cap
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength).trim();
  }

  return cleaned;
}
