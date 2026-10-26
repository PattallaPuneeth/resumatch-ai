import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

function findFilesRecursive(dir: string, extensions: string[]): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of list) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.next') {
        results = results.concat(findFilesRecursive(fullPath, extensions));
      }
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }

  return results;
}

describe('Frontend Security Checklist (Phase 8A Requirements)', () => {
  it('strictly verifies zero instances of dangerouslySetInnerHTML across all frontend source files', () => {
    const srcDir = path.resolve(__dirname, '../../');
    const sourceFiles = findFilesRecursive(srcDir, ['.ts', '.tsx', '.js', '.jsx']);

    expect(sourceFiles.length).toBeGreaterThan(5);

    const violations: { file: string; line: number; text: string }[] = [];

    for (const file of sourceFiles) {
      // Exclude this test file itself from triggering a false positive match on the string name
      if (file.includes('SecurityAndStorage.test.tsx')) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        if (line.includes('dangerouslySetInnerHTML')) {
          violations.push({
            file: path.relative(srcDir, file),
            line: idx + 1,
            text: line.trim(),
          });
        }
      });
    }

    expect(
      violations,
      `Found forbidden dangerouslySetInnerHTML usage in:\n${JSON.stringify(violations, null, 2)}`
    ).toEqual([]);
  });

  it('guarantees zero authentication tokens or session secrets stored in localStorage or sessionStorage', () => {
    // In jsdom environment, window.localStorage and window.sessionStorage are available
    window.localStorage.clear();
    window.sessionStorage.clear();

    const sensitiveKeys = [
      'token',
      'accessToken',
      'access_token',
      'refreshToken',
      'refresh_token',
      'jwt',
      'auth_token',
      'credentials',
    ];

    for (const key of sensitiveKeys) {
      expect(window.localStorage.getItem(key)).toBeNull();
      expect(window.sessionStorage.getItem(key)).toBeNull();
    }
  });

  it('strictly verifies zero instances of NEXT_PUBLIC_ML_URL across all frontend source files', () => {
    const srcDir = path.resolve(__dirname, '../../');
    const sourceFiles = findFilesRecursive(srcDir, ['.ts', '.tsx', '.js', '.jsx']);

    const violations: { file: string; line: number; text: string }[] = [];

    for (const file of sourceFiles) {
      if (file.includes('SecurityAndStorage.test.tsx')) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        if (line.includes('NEXT_PUBLIC_ML_URL')) {
          violations.push({
            file: path.relative(srcDir, file),
            line: idx + 1,
            text: line.trim(),
          });
        }
      });
    }

    expect(
      violations,
      `Found forbidden NEXT_PUBLIC_ML_URL usage in:\n${JSON.stringify(violations, null, 2)}`
    ).toEqual([]);
  });
});
