/**
 * Phase 10A - Item C2: State Machine Unit Tests
 *
 * Validates allowed transitions, forbidden transitions, idempotent self-transitions,
 * and terminal state immutability for Resume and Analysis lifecycles.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateResumeTransition,
  assertValidResumeTransition,
  evaluateAnalysisTransition,
  assertValidAnalysisTransition,
  InvalidStateTransitionError,
  ResumeStatus,
  AnalysisStatus,
} from '../services/stateMachines.js';

describe('C2: Resume State Machine', () => {
  it('allows standard forward document lifecycle', () => {
    // Normal text-layer lifecycle
    expect(evaluateResumeTransition('UPLOAD_PENDING', 'UPLOADED').allowed).toBe(true);
    expect(evaluateResumeTransition('UPLOADED', 'EXTRACTING').allowed).toBe(true);
    expect(evaluateResumeTransition('EXTRACTING', 'PARSED').allowed).toBe(true);

    // OCR lifecycle
    expect(evaluateResumeTransition('EXTRACTING', 'NEEDS_OCR').allowed).toBe(true);
    expect(evaluateResumeTransition('NEEDS_OCR', 'OCR_PROCESSING').allowed).toBe(true);
    expect(evaluateResumeTransition('OCR_PROCESSING', 'PARSED').allowed).toBe(true);
  });

  it('allows failure transitions from any non-terminal state', () => {
    const activeStates: ResumeStatus[] = [
      'UPLOAD_PENDING',
      'UPLOADED',
      'EXTRACTING',
      'NEEDS_OCR',
      'OCR_PROCESSING',
    ];

    for (const state of activeStates) {
      const evalResult = evaluateResumeTransition(state, 'FAILED');
      expect(evalResult.allowed).toBe(true);
      expect(evalResult.isNoOp).toBe(false);
      expect(() => assertValidResumeTransition(state, 'FAILED')).not.toThrow();
    }
  });

  it('treats identical source and destination as an idempotent no-op', () => {
    const allStates: ResumeStatus[] = [
      'UPLOAD_PENDING',
      'UPLOADED',
      'EXTRACTING',
      'NEEDS_OCR',
      'OCR_PROCESSING',
      'PARSED',
      'FAILED',
    ];

    for (const state of allStates) {
      const evalResult = evaluateResumeTransition(state, state);
      expect(evalResult.allowed).toBe(true);
      expect(evalResult.isNoOp).toBe(true);
      expect(() => assertValidResumeTransition(state, state)).not.toThrow();
    }
  });

  it('forbids backwards transitions and mutations from terminal PARSED state', () => {
    const invalidFromParsed: ResumeStatus[] = [
      'UPLOAD_PENDING',
      'UPLOADED',
      'EXTRACTING',
      'NEEDS_OCR',
      'OCR_PROCESSING',
      'FAILED',
    ];

    for (const target of invalidFromParsed) {
      const evalResult = evaluateResumeTransition('PARSED', target);
      expect(evalResult.allowed).toBe(false);
      expect(evalResult.isNoOp).toBe(false);
      expect(() => assertValidResumeTransition('PARSED', target)).toThrow(
        InvalidStateTransitionError
      );
    }
  });

  it('forbids mutations from terminal FAILED state', () => {
    const invalidFromFailed: ResumeStatus[] = [
      'UPLOAD_PENDING',
      'UPLOADED',
      'EXTRACTING',
      'NEEDS_OCR',
      'OCR_PROCESSING',
      'PARSED',
    ];

    for (const target of invalidFromFailed) {
      const evalResult = evaluateResumeTransition('FAILED', target);
      expect(evalResult.allowed).toBe(false);
      expect(() => assertValidResumeTransition('FAILED', target)).toThrow(
        InvalidStateTransitionError
      );
    }
  });

  it('forbids illegal skipped transitions (e.g. UPLOAD_PENDING -> PARSED directly)', () => {
    expect(evaluateResumeTransition('UPLOAD_PENDING', 'PARSED').allowed).toBe(false);
    expect(evaluateResumeTransition('UPLOAD_PENDING', 'EXTRACTING').allowed).toBe(false);
    expect(evaluateResumeTransition('UPLOADED', 'PARSED').allowed).toBe(false);
  });
});

describe('C2: Analysis State Machine', () => {
  it('allows standard forward analysis lifecycle', () => {
    expect(evaluateAnalysisTransition('PENDING', 'PROCESSING').allowed).toBe(true);
    expect(evaluateAnalysisTransition('PROCESSING', 'COMPLETED').allowed).toBe(true);
  });

  it('allows failure transitions from active states', () => {
    expect(evaluateAnalysisTransition('PENDING', 'FAILED').allowed).toBe(true);
    expect(evaluateAnalysisTransition('PROCESSING', 'FAILED').allowed).toBe(true);
  });

  it('treats identical source and destination as idempotent no-op', () => {
    const allStates: AnalysisStatus[] = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'];
    for (const state of allStates) {
      const res = evaluateAnalysisTransition(state, state);
      expect(res.allowed).toBe(true);
      expect(res.isNoOp).toBe(true);
    }
  });

  it('forbids mutations from terminal COMPLETED or FAILED states', () => {
    expect(evaluateAnalysisTransition('COMPLETED', 'PROCESSING').allowed).toBe(false);
    expect(evaluateAnalysisTransition('COMPLETED', 'FAILED').allowed).toBe(false);
    expect(evaluateAnalysisTransition('FAILED', 'COMPLETED').allowed).toBe(false);
    expect(() => assertValidAnalysisTransition('COMPLETED', 'PENDING')).toThrow(
      InvalidStateTransitionError
    );
  });
});
