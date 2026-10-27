/**
 * Phase 10A - Item C2: Central State Machine Guard & Transition Rules
 *
 * Enforces valid state lifecycles and guards against illegal transitions
 * or out-of-order execution across distributed workers.
 */

export type ResumeStatus =
  | 'UPLOAD_PENDING'
  | 'UPLOADED'
  | 'EXTRACTING'
  | 'NEEDS_OCR'
  | 'OCR_PROCESSING'
  | 'PARSED'
  | 'FAILED';

export type AnalysisStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly entity: 'Resume' | 'Analysis',
    public readonly from: string,
    public readonly to: string
  ) {
    super(`Invalid ${entity} state transition from '${from}' to '${to}'`);
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Allowed forward transitions for Resume entities.
 * Self-transitions (from === to) are considered idempotent no-ops.
 */
export const ALLOWED_RESUME_TRANSITIONS: Record<ResumeStatus, ReadonlySet<ResumeStatus>> = {
  UPLOAD_PENDING: new Set(['UPLOADED', 'FAILED']),
  UPLOADED: new Set(['EXTRACTING', 'FAILED']),
  EXTRACTING: new Set(['NEEDS_OCR', 'OCR_PROCESSING', 'PARSED', 'FAILED']),
  NEEDS_OCR: new Set(['OCR_PROCESSING', 'FAILED']),
  OCR_PROCESSING: new Set(['PARSED', 'FAILED']),
  PARSED: new Set([]), // Terminal state
  FAILED: new Set([]), // Terminal state
};

/**
 * Allowed forward transitions for Analysis entities.
 */
export const ALLOWED_ANALYSIS_TRANSITIONS: Record<AnalysisStatus, ReadonlySet<AnalysisStatus>> = {
  PENDING: new Set(['PROCESSING', 'FAILED']),
  PROCESSING: new Set(['COMPLETED', 'FAILED']),
  COMPLETED: new Set([]), // Terminal state
  FAILED: new Set([]), // Terminal state
};

export interface TransitionEvaluation {
  allowed: boolean;
  isNoOp: boolean;
  reason?: string;
}

export function evaluateResumeTransition(
  from: ResumeStatus,
  to: ResumeStatus
): TransitionEvaluation {
  if (from === to) {
    return { allowed: true, isNoOp: true };
  }

  const allowedTargets = ALLOWED_RESUME_TRANSITIONS[from];
  if (!allowedTargets) {
    return {
      allowed: false,
      isNoOp: false,
      reason: `Unknown source status: '${from}'`,
    };
  }

  if (allowedTargets.has(to)) {
    return { allowed: true, isNoOp: false };
  }

  return {
    allowed: false,
    isNoOp: false,
    reason: `Transition from '${from}' to '${to}' is not permitted`,
  };
}

export function assertValidResumeTransition(from: ResumeStatus, to: ResumeStatus): void {
  const result = evaluateResumeTransition(from, to);
  if (!result.allowed) {
    throw new InvalidStateTransitionError('Resume', from, to);
  }
}

export function evaluateAnalysisTransition(
  from: AnalysisStatus,
  to: AnalysisStatus
): TransitionEvaluation {
  if (from === to) {
    return { allowed: true, isNoOp: true };
  }

  const allowedTargets = ALLOWED_ANALYSIS_TRANSITIONS[from];
  if (!allowedTargets) {
    return {
      allowed: false,
      isNoOp: false,
      reason: `Unknown source status: '${from}'`,
    };
  }

  if (allowedTargets.has(to)) {
    return { allowed: true, isNoOp: false };
  }

  return {
    allowed: false,
    isNoOp: false,
    reason: `Transition from '${from}' to '${to}' is not permitted`,
  };
}

export function assertValidAnalysisTransition(from: AnalysisStatus, to: AnalysisStatus): void {
  const result = evaluateAnalysisTransition(from, to);
  if (!result.allowed) {
    throw new InvalidStateTransitionError('Analysis', from, to);
  }
}
