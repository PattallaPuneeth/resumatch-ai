import { hash, verify, Algorithm } from '@node-rs/argon2';
import crypto from 'crypto';
import { isCommonPassword } from './commonPasswords.js';

// OWASP Recommended Minimum Parameters for Argon2id:
// - Algorithm: Argon2id (2)
// - Memory: 19 MiB (19456 KiB)
// - Iterations / TimeCost: 2
// - Parallelism: 1
export const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

// Pre-computed dummy Argon2id hash for unknown user timing equalization
// Hash of an unguessable 64-character random string with identical OWASP parameters
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlzYWx0MTIzNDU2Nw$4kUeK7R3bKx78QvY+n5/Qe9uM8z9s8e4/2m3r1s7y5w';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateUsernamePolicy(username: string): ValidationResult {
  if (typeof username !== 'string') {
    return { valid: false, error: 'Username must be a string' };
  }
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 32) {
    return { valid: false, error: 'Username must be between 3 and 32 characters' };
  }
  const usernameRegex = /^[a-zA-Z0-9_.-]+$/;
  if (!usernameRegex.test(trimmed)) {
    return {
      valid: false,
      error: 'Username can only contain alphanumeric characters, underscores, dashes, and periods',
    };
  }
  return { valid: true };
}

export function validatePasswordPolicy(password: string, username: string): ValidationResult {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password must be a string' };
  }
  if (password.length < 12 || password.length > 128) {
    return { valid: false, error: 'Password must be between 12 and 128 characters' };
  }
  if (username && username.trim().length >= 3) {
    if (password.toLowerCase().includes(username.trim().toLowerCase())) {
      return { valid: false, error: 'Password must not contain the username' };
    }
  }
  if (isCommonPassword(password)) {
    return { valid: false, error: 'Password is too common and easily guessable' };
  }
  return { valid: true };
}

export class HashingConcurrencyLimiter {
  private active = 0;
  private maxConcurrent: number;
  private queue: Array<() => void> = [];

  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      });
    });
  }

  private release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.active--;
    }
  }

  getActiveCount(): number {
    return this.active;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  setMaxConcurrent(limit: number) {
    this.maxConcurrent = limit;
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }
}

export const hashingLimiter = new HashingConcurrencyLimiter(
  parseInt(process.env.ARGON2_MAX_CONCURRENCY || '10', 10)
);

export async function hashPassword(password: string): Promise<string> {
  const release = await hashingLimiter.acquire();
  try {
    return await hash(password, ARGON2_OPTIONS);
  } finally {
    release();
  }
}

export async function verifyPassword(passwordHash: string, passwordCandidate: string): Promise<boolean> {
  const release = await hashingLimiter.acquire();
  try {
    return await verify(passwordHash, passwordCandidate);
  } catch {
    return false;
  } finally {
    release();
  }
}

export async function dummyArgon2Verify(passwordCandidate: string): Promise<boolean> {
  const release = await hashingLimiter.acquire();
  try {
    await verify(DUMMY_HASH, passwordCandidate);
  } catch {
    // Ignore error in dummy verify
  } finally {
    release();
  }
  return false;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Equalize branch timing by still executing a constant-time comparison on dummy buffer
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
