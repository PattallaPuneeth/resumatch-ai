/**
 * Bundled common passwords list for Phase 5 password policy enforcement.
 * Passwords matching any entry in this list will be rejected at registration/reset.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '123456789012',
  'password1234',
  'password12345',
  'password123456',
  'qwertyuiop12',
  'qwerty123456',
  'admin1234567',
  'administrator12',
  'iloveyou1234',
  'changeme1234',
  'welcome12345',
  'letmein12345',
  'monkey123456',
  'dragon123456',
  'master123456',
  'sunshine1234',
  'football1234',
  'baseball1234',
  'superman1234',
  'trustno11234',
  'princess1234',
  'shadow123456',
  'michael12345',
  'jennifer1234',
  'jessica12345',
  'charlie12345',
  'mustang12345',
  'freedom12345',
  'whatever1234',
  'correcthorsebatterystaple',
]);

export function isCommonPassword(candidate: string): boolean {
  return COMMON_PASSWORDS.has(candidate.toLowerCase().trim());
}

