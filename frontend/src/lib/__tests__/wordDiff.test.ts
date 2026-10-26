import { describe, it, expect } from 'vitest';
import { computeWordDiff } from '../wordDiff';

describe('computeWordDiff', () => {
  it('returns empty array when both inputs are empty', () => {
    expect(computeWordDiff('', '')).toEqual([]);
  });

  it('handles unchanged identical strings', () => {
    const text = 'Architected distributed backend pipelines.';
    const diff = computeWordDiff(text, text);
    expect(diff).toEqual([{ type: 'unchanged', text }]);
  });

  it('detects pure additions', () => {
    const diff = computeWordDiff('', 'Built microservices.');
    expect(diff).toEqual([{ type: 'added', text: 'Built microservices.' }]);
  });

  it('detects pure deletions', () => {
    const diff = computeWordDiff('Deprecated legacy system.', '');
    expect(diff).toEqual([{ type: 'removed', text: 'Deprecated legacy system.' }]);
  });

  it('identifies word replacements correctly', () => {
    const original = 'Maintained existing codebase and fixed bugs.';
    const rewritten = 'Engineered modern codebase and resolved defects.';
    const diff = computeWordDiff(original, rewritten);

    const types = diff.map((d) => d.type);
    expect(types).toContain('unchanged');
    expect(types).toContain('removed');
    expect(types).toContain('added');

    // Confirm plain text reconstruction
    const removedText = diff
      .filter((d) => d.type === 'removed' || d.type === 'unchanged')
      .map((d) => d.text)
      .join('');
    expect(removedText).toBe(original);

    const addedText = diff
      .filter((d) => d.type === 'added' || d.type === 'unchanged')
      .map((d) => d.text)
      .join('');
    expect(addedText).toBe(rewritten);
  });

  it('handles unicode and multi-byte characters cleanly', () => {
    const original = 'Developed scalable backend in Tokyo (東京).';
    const rewritten = 'Developed high-scale backend in Tokyo (東京) with 99.9% uptime.';
    const diff = computeWordDiff(original, rewritten);

    expect(diff.some((d) => d.text.includes('東京'))).toBe(true);
    expect(diff.some((d) => d.text.includes('99.9% uptime'))).toBe(true);
  });

  it('handles malicious string payloads inertly as text tokens', () => {
    const original = 'Added feature <script>alert("xss")</script>';
    const rewritten = 'Added secure feature <img src=x onerror=alert(1)>';
    const diff = computeWordDiff(original, rewritten);

    for (const token of diff) {
      expect(typeof token.text).toBe('string');
      expect(['added', 'removed', 'unchanged']).toContain(token.type);
    }
  });

  it('gracefully handles very long inputs exceeding token cap', () => {
    const longOrig = 'word '.repeat(300);
    const longRewr = 'term '.repeat(300);
    const diff = computeWordDiff(longOrig, longRewr);

    expect(diff).toHaveLength(2);
    expect(diff[0].type).toBe('removed');
    expect(diff[1].type).toBe('added');
  });

  it('handles Right-to-Left (RTL) unicode strings cleanly', () => {
    const original = 'تم تطوير الواجهة الخلفية';
    const rewritten = 'تم تطوير البنية التحتية بنجاح';
    const diff = computeWordDiff(original, rewritten);

    expect(diff.some((d) => d.text.includes('تطوير'))).toBe(true);
    expect(diff.some((d) => d.type === 'removed')).toBe(true);
    expect(diff.some((d) => d.type === 'added')).toBe(true);
  });
});
