import { describe, it, expect } from 'vitest';
import { validateExternalUrl } from '../safeUrl';

describe('Safe External URL Validator (src/lib/safeUrl.ts)', () => {
  it('accepts valid https URLs and extracts the hostname', () => {
    const res = validateExternalUrl('https://boards.greenhouse.io/acme/jobs/12345');
    expect(res.isValid).toBe(true);
    expect(res.safeUrl).toBe('https://boards.greenhouse.io/acme/jobs/12345');
    expect(res.hostname).toBe('boards.greenhouse.io');
  });

  it('accepts valid http URLs', () => {
    const res = validateExternalUrl('http://jobs.lever.co/vanguard/987');
    expect(res.isValid).toBe(true);
    expect(res.safeUrl).toBe('http://jobs.lever.co/vanguard/987');
    expect(res.hostname).toBe('jobs.lever.co');
  });

  it('rejects javascript: pseudo-protocol (XSS prevention)', () => {
    const res = validateExternalUrl('javascript:alert(document.cookie)');
    expect(res.isValid).toBe(false);
    expect(res.safeUrl).toBe('#');
    expect(res.hostname).toBe('invalid-protocol');
  });

  it('rejects data: protocol URLs', () => {
    const res = validateExternalUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==');
    expect(res.isValid).toBe(false);
    expect(res.safeUrl).toBe('#');
    expect(res.hostname).toBe('invalid-protocol');
  });

  it('rejects file: protocol URLs', () => {
    const res = validateExternalUrl('file:///etc/passwd');
    expect(res.isValid).toBe(false);
    expect(res.safeUrl).toBe('#');
    expect(res.hostname).toBe('invalid-protocol');
  });

  it('rejects vbscript: and blob: URLs', () => {
    expect(validateExternalUrl('vbscript:msgbox(1)').isValid).toBe(false);
    expect(validateExternalUrl('blob:http://localhost:3000/uuid').isValid).toBe(false);
  });

  it('handles null, undefined, empty, and malformed inputs gracefully', () => {
    expect(validateExternalUrl(null).isValid).toBe(false);
    expect(validateExternalUrl(undefined).isValid).toBe(false);
    expect(validateExternalUrl('').isValid).toBe(false);
    expect(validateExternalUrl('   ').isValid).toBe(false);
    expect(validateExternalUrl('not a url at all').isValid).toBe(false);
  });
});
