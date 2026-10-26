/**
 * Word-level diff utility for Phase 8C Bullet Editor.
 * Computes difference tokens (added, removed, unchanged) between two strings.
 * Generates pure text tokens only (zero raw HTML injection).
 */

export type DiffType = 'added' | 'removed' | 'unchanged';

export interface DiffToken {
  type: DiffType;
  text: string;
}

/**
 * Splits text into words and punctuation tokens preserving whitespace.
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  // Tokenize words, whitespace sequences, and punctuation
  const matches = text.match(/\s+|[^\s\p{P}]+|\p{P}/gu);
  return matches || [text];
}

/**
 * Computes word-level diff using the Longest Common Subsequence (LCS) algorithm.
 * Guarantees plain text token output.
 */
export function computeWordDiff(original: string, rewritten: string): DiffToken[] {
  if (original === rewritten) {
    return original ? [{ type: 'unchanged', text: original }] : [];
  }

  if (!original) {
    return rewritten ? [{ type: 'added', text: rewritten }] : [];
  }

  if (!rewritten) {
    return [{ type: 'removed', text: original }];
  }

  const origTokens = tokenize(original);
  const rewrTokens = tokenize(rewritten);

  const n = origTokens.length;
  const m = rewrTokens.length;

  // Compute LCS table
  // For memory safety with very long inputs, cap token lengths
  const MAX_TOKENS = 500;
  if (n > MAX_TOKENS || m > MAX_TOKENS) {
    // Fallback for extreme inputs: treat entire text as replace
    return [
      { type: 'removed', text: original },
      { type: 'added', text: rewritten },
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (origTokens[i - 1] === rewrTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to extract diff tokens
  let i = n;
  let j = m;
  const rawDiff: DiffToken[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origTokens[i - 1] === rewrTokens[j - 1]) {
      rawDiff.push({ type: 'unchanged', text: origTokens[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawDiff.push({ type: 'added', text: rewrTokens[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      rawDiff.push({ type: 'removed', text: origTokens[i - 1] });
      i--;
    }
  }

  rawDiff.reverse();

  // Merge contiguous tokens of the same type
  const merged: DiffToken[] = [];
  for (const token of rawDiff) {
    if (merged.length > 0 && merged[merged.length - 1].type === token.type) {
      merged[merged.length - 1].text += token.text;
    } else {
      merged.push({ ...token });
    }
  }

  return merged;
}
