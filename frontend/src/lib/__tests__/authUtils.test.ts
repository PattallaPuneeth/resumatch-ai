import { describe, expect, it } from 'vitest';
import { sanitizeNextRedirect, validateUsername, validatePassword } from '../authUtils';

describe('Auth Utilities & Open-Redirect Defense', () => {
  describe('sanitizeNextRedirect', () => {
    it('accepts valid same-origin relative paths', () => {
      expect(sanitizeNextRedirect('/dashboard')).toBe('/dashboard');
      expect(sanitizeNextRedirect('/account')).toBe('/account');
      expect(sanitizeNextRedirect('/resumes/123')).toBe('/resumes/123');
      expect(sanitizeNextRedirect('/jobs?category=engineering')).toBe('/jobs?category=engineering');
    });

    it('rejects external URLs and protocol schemes', () => {
      expect(sanitizeNextRedirect('http://attacker.example.com')).toBe('/dashboard');
      expect(sanitizeNextRedirect('https://attacker.example.com/steal')).toBe('/dashboard');
      expect(sanitizeNextRedirect('javascript:alert(1)')).toBe('/dashboard');
      expect(sanitizeNextRedirect('data:text/html,evil')).toBe('/dashboard');
    });

    it('rejects protocol-relative and malformed relative paths', () => {
      expect(sanitizeNextRedirect('//attacker.example.com')).toBe('/dashboard');
      expect(sanitizeNextRedirect('/\\attacker.example.com')).toBe('/dashboard');
      expect(sanitizeNextRedirect('///attacker.example.com')).toBe('/dashboard');
    });

    it('rejects colon schemes hidden inside path', () => {
      expect(sanitizeNextRedirect('/javascript:alert(1)')).toBe('/dashboard');
    });

    it('handles null, undefined, empty string with fallback', () => {
      expect(sanitizeNextRedirect(null)).toBe('/dashboard');
      expect(sanitizeNextRedirect(undefined)).toBe('/dashboard');
      expect(sanitizeNextRedirect('')).toBe('/dashboard');
      expect(sanitizeNextRedirect('   ')).toBe('/dashboard');
      expect(sanitizeNextRedirect(null, '/custom-fallback')).toBe('/custom-fallback');
    });
  });

  describe('validateUsername', () => {
    it('approves compliant usernames', () => {
      expect(validateUsername('alice').valid).toBe(true);
      expect(validateUsername('candidate_42').valid).toBe(true);
      expect(validateUsername('dev.lead-1').valid).toBe(true);
    });

    it('rejects short, long, or non-alphanumeric usernames', () => {
      expect(validateUsername('ab').valid).toBe(false);
      expect(validateUsername('a'.repeat(33)).valid).toBe(false);
      expect(validateUsername('user@domain').valid).toBe(false);
      expect(validateUsername('user<script>').valid).toBe(false);
      expect(validateUsername('').valid).toBe(false);
    });
  });

  describe('validatePassword', () => {
    it('approves passwords satisfying length and username independence', () => {
      expect(validatePassword('SuperSecurePassword2026!', 'alice').valid).toBe(true);
      expect(validatePassword('a'.repeat(12), 'bob').valid).toBe(true);
    });

    it('rejects passwords shorter than 12 characters', () => {
      const result = validatePassword('Short1!', 'alice');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('between 12 and 128 characters');
    });

    it('rejects passwords longer than 128 characters', () => {
      const result = validatePassword('a'.repeat(129), 'alice');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('between 12 and 128 characters');
    });

    it('rejects passwords containing the username', () => {
      const result = validatePassword('PasswordWithAliceInside123', 'alice');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must not contain the username');
    });
  });
});
