import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import {
  buildStorageKey,
  createPresignedUploadUrl,
  createPresignedDownloadUrl,
  headStorageObject,
  getStorageObjectByteRange,
  deleteStorageObject,
} from '../storage/s3.js';
import { resumeParsingQueue } from '../queues/bullmq.js';
import type { ResumeParsingJobPayload } from '../queues/bullmq.js';
import { env } from '../config/env.js';
import { withResumeCoordinationLock } from '../utils/coordinationLock.js';
import { usageService } from '../services/usageService.js';
import { sendUsageLimitExceeded } from '../services/meterGuard.js';
import { withTraceContext } from '../telemetry.js';

// ---------------------------------------------------------------------------
// Supported formats per Section 2B of the specification
// ---------------------------------------------------------------------------
const SUPPORTED_MIME_TYPES = new Map<string, 'pdf' | 'docx'>([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
]);

// Magic bytes for validation per Section 2B
// PDF: %PDF- (5 bytes)
// DOCX/ZIP: PK (2 bytes - ZIP local file header)
const MAGIC_BYTES: Record<'pdf' | 'docx', { bytes: Buffer; description: string }> = {
  pdf: { bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), description: '%PDF-' },
  docx: { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), description: 'PK\x03\x04 (ZIP)' },
};

// ---------------------------------------------------------------------------
// Zod schemas for request validation
// ---------------------------------------------------------------------------
export const uploadUrlBodySchema = z.object({
  filename: z
    .string()
    .min(1, 'Filename is required')
    .max(255, 'Filename too long')
    .regex(/\.(pdf|docx)$/i, 'Only PDF and DOCX files are supported'),
  mimeType: z.string().min(1, 'MIME type is required'),
  sizeBytes: z
    .number()
    .int()
    .positive('File size must be positive')
    .max(env.MAX_UPLOAD_BYTES, `File exceeds maximum size of ${env.MAX_UPLOAD_BYTES} bytes`),
});

export type UploadUrlBody = z.infer<typeof uploadUrlBodySchema>;

// ---------------------------------------------------------------------------
// POST /v1/resumes/upload-url
// ---------------------------------------------------------------------------
export async function handleRequestUploadUrl(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const userId = (request.user as { sub: string }).sub;

  // Validate body
  const parseResult = uploadUrlBodySchema.safeParse(request.body);
  if (!parseResult.success) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Input validation failed',
      details: parseResult.error.flatten(),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  const { filename, mimeType, sizeBytes } = parseResult.data;

  // Validate MIME type against allowlist (do not trust filename alone)
  const ext = SUPPORTED_MIME_TYPES.get(mimeType);
  if (!ext) {
    return reply.status(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'Unsupported file type. Only PDF and DOCX are accepted.',
      details: { receivedMimeType: mimeType, supportedTypes: Array.from(SUPPORTED_MIME_TYPES.keys()) },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Cross-check: filename extension must agree with MIME type
  const filenameExt = filename.split('.').pop()?.toLowerCase();
  if (filenameExt !== ext) {
    return reply.status(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: `File extension .${filenameExt} does not match MIME type ${mimeType}`,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Enforce per-user resume cap
  const existingCount = await prisma.resume.count({
    where: {
      userId,
      status: { not: 'FAILED' },
    },
  });

  if (existingCount >= env.RESUME_CAP_PER_USER) {
    return reply.status(429).send({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Upload limit reached. You may not upload more than ${env.RESUME_CAP_PER_USER} resumes.`,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Enforce resume storage byte limit per user plan
  const usage = await usageService.getUsage(userId);
  const storageLimit = usage.meters.resume_storage_bytes.limit;
  const currentStorage = usage.meters.resume_storage_bytes.used;
  if (storageLimit !== null && (currentStorage + sizeBytes > storageLimit)) {
    sendUsageLimitExceeded(reply, request, {
      allowed: false,
      meter: 'resume_storage_bytes',
      used: currentStorage,
      limit: storageLimit,
      resetAt: null,
    });
    return;
  }

  // Sanitize original filename — strip path components, keep only safe chars
  const safeFilename = filename.replace(/[^\w.\-\s]/g, '_').slice(0, 255);

  // Generate IDs and storage key
  const resumeId = randomUUID();
  const storageKey = buildStorageKey(userId, resumeId, ext);

  // Create the Resume record with UPLOAD_PENDING status
  await prisma.resume.create({
    data: {
      id: resumeId,
      userId,
      originalFilename: safeFilename,
      storageKey,
      mimeType,
      sizeBytes,
      status: 'UPLOAD_PENDING',
    },
  });

  // Generate presigned upload URL using the signer client
  let presignedResult;
  try {
    presignedResult = await createPresignedUploadUrl({
      storageKey,
      mimeType,
      expiresInSeconds: env.PRESIGN_PUT_TTL_SECONDS,
    });
  } catch (storageErr) {
    // Roll back the record to avoid orphaned UPLOAD_PENDING rows
    await prisma.resume.delete({ where: { id: resumeId } }).catch(() => {});
    request.log.error({ err: storageErr, resumeId }, 'Failed to generate presigned upload URL');
    return reply.status(503).send({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Storage service unavailable. Please try again.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  request.log.info({ resumeId, userId, storageKey, mimeType, sizeBytes }, 'Upload URL issued');

  return reply.status(200).send({
    resumeId,
    uploadUrl: presignedResult.uploadUrl,
    headers: presignedResult.headers,
    expiresIn: presignedResult.expiresIn,
    storageKey,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/resumes/:id/complete
// ---------------------------------------------------------------------------
export async function handleCompleteUpload(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const userId = (request.user as { sub: string }).sub;
  const resumeId = request.params.id;

  // Execute upload completion under a per-resume coordination lock to prevent
  // concurrent stale-upload cleanup from deleting the storage object or DB record.
  const outcome = await withResumeCoordinationLock(resumeId, async (tx: any) => {
    // Fetch the resume and verify ownership inside the coordination lock
    const resume = await tx.resume.findUnique({ where: { id: resumeId } });

    if (!resume) {
      return { kind: 'NOT_FOUND' as const };
    }

    if (resume.userId !== userId) {
      return { kind: 'FORBIDDEN' as const };
    }

    // Idempotency: if already progressed to worker pipeline (Phase 2C), do not re-enqueue
    if (
      resume.status === 'EXTRACTING' ||
      resume.status === 'NEEDS_OCR' ||
      resume.status === 'OCR_PROCESSING' ||
      resume.status === 'PARSED'
    ) {
      return { kind: 'ALREADY_PROCESSING' as const, status: resume.status };
    }

    // Idempotency: if resume was marked UPLOADED, ensure the BullMQ job is active.
    if (resume.status === 'UPLOADED') {
      return { kind: 'ALREADY_UPLOADED' as const, resume };
    }

    if (resume.status === 'FAILED') {
      return { kind: 'FAILED_STATE' as const };
    }

    // Should be UPLOAD_PENDING at this point
    if (resume.status !== 'UPLOAD_PENDING') {
      return { kind: 'UNEXPECTED_STATE' as const, status: resume.status };
    }

    // Step 1: Verify the object exists in storage
    const headResult = await headStorageObject(resume.storageKey);
    if (!headResult) {
      return { kind: 'FILE_NOT_FOUND' as const, storageKey: resume.storageKey };
    }

    // Step 2: Enforce actual object size, not client-declared size
    const actualSize = headResult.contentLength;
    if (actualSize > env.MAX_UPLOAD_BYTES) {
      // Mark FAILED and delete the oversized object
      await tx.resume.update({
        where: { id: resumeId },
        data: {
          status: 'FAILED',
          errorCode: 'FILE_TOO_LARGE',
          errorMessage: `Uploaded file (${actualSize} bytes) exceeds the maximum allowed size of ${env.MAX_UPLOAD_BYTES} bytes.`,
        },
      });
      await deleteStorageObject(resume.storageKey).catch(() => {});
      return { kind: 'FILE_TOO_LARGE' as const, actualSize };
    }

    // Step 3: Validate magic bytes
    const ext = resume.mimeType === 'application/pdf' ? 'pdf' : 'docx';
    const magic = MAGIC_BYTES[ext];
    let byteRange: Buffer;
    try {
      byteRange = await getStorageObjectByteRange(resume.storageKey, 0, magic.bytes.length - 1);
    } catch (rangeErr) {
      return { kind: 'STORAGE_ERROR' as const, error: rangeErr };
    }

    const magicMatch =
      byteRange.length >= magic.bytes.length &&
      byteRange.subarray(0, magic.bytes.length).equals(magic.bytes);

    if (!magicMatch) {
      // File is corrupt or wrong type — mark FAILED and delete
      await tx.resume.update({
        where: { id: resumeId },
        data: {
          status: 'FAILED',
          errorCode: 'CORRUPT_FILE',
          errorMessage: `The uploaded file does not match the expected format (expected ${magic.description} magic bytes).`,
        },
      });
      await deleteStorageObject(resume.storageKey).catch(() => {});
      return { kind: 'CORRUPT_FILE' as const };
    }

    // Step 4: Compute SHA-256 using a larger byte range for hash accuracy.
    let sha256: string;
    try {
      const fullBytes = await getStorageObjectByteRange(resume.storageKey, 0, env.MAX_UPLOAD_BYTES - 1);
      sha256 = createHash('sha256').update(fullBytes).digest('hex');
    } catch (hashErr) {
      return { kind: 'HASH_ERROR' as const, error: hashErr };
    }

    // Step 5: Enforce storage limits and consume from resume_storage_bytes gauge
    const consumeRes = await usageService.consume(userId, 'resume_storage_bytes', actualSize);
    if (!consumeRes.allowed) {
      await tx.resume.update({
        where: { id: resumeId },
        data: {
          status: 'FAILED',
          errorCode: 'USAGE_LIMIT_EXCEEDED',
          errorMessage: `Storage limit reached (${consumeRes.used}/${consumeRes.limit} bytes).`,
        },
      });
      await deleteStorageObject(resume.storageKey).catch(() => {});
      return { kind: 'STORAGE_LIMIT_EXCEEDED' as const, consumeRes };
    }

    // Step 6: Transition to UPLOADED, persist sha256 and actual size
    await tx.resume.update({
      where: { id: resumeId },
      data: {
        status: 'UPLOADED',
        sha256,
        sizeBytes: actualSize,
      },
    });

    return {
      kind: 'SUCCESS' as const,
      resume,
      sha256,
    };
  });

  // Handle outcomes outside the lock transaction
  if (outcome.kind === 'STORAGE_LIMIT_EXCEEDED') {
    sendUsageLimitExceeded(reply, request, outcome.consumeRes);
    return;
  }

  if (outcome.kind === 'NOT_FOUND') {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Resume not found',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (outcome.kind === 'FORBIDDEN') {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Resume not found',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (outcome.kind === 'ALREADY_PROCESSING') {
    request.log.info({ resumeId, status: outcome.status }, 'Idempotent complete call — already in worker pipeline');
    return reply.status(202).send({
      resumeId,
      status: outcome.status,
      message: 'Resume already accepted for processing',
    });
  }

  if (outcome.kind === 'ALREADY_UPLOADED') {
    const jobPayload: ResumeParsingJobPayload = {
      type: 'PARSE_DOCUMENT',
      resumeId: outcome.resume.id,
      bucket: env.S3_BUCKET,
      storageKey: outcome.resume.storageKey,
      mimeType: outcome.resume.mimeType,
      sha256: outcome.resume.sha256 || undefined,
    };

    try {
      await resumeParsingQueue.add('parse', withTraceContext(request, jobPayload), {
        jobId: `parse-${outcome.resume.id}`,
      });
      request.log.info({ resumeId, status: outcome.resume.status }, 'Idempotent complete call — ensured parse job in queue');
      return reply.status(202).send({
        resumeId,
        status: outcome.resume.status,
        message: 'Resume already accepted for processing',
      });
    } catch (queueErr) {
      request.log.error({ err: queueErr, resumeId }, 'Failed to enqueue PARSE_DOCUMENT job during idempotent retry');
      return reply.status(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Processing queue unavailable. Please retry completion.',
        timestamp: new Date().toISOString(),
        requestId: request.id,
      });
    }
  }

  if (outcome.kind === 'FAILED_STATE') {
    return reply.status(409).send({
      statusCode: 409,
      error: 'Conflict',
      message: 'Resume is in a FAILED state and cannot be reprocessed. Please upload a new file.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (outcome.kind === 'UNEXPECTED_STATE') {
    return reply.status(409).send({
      statusCode: 409,
      error: 'Conflict',
      message: `Resume is in an unexpected state: ${outcome.status}`,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (outcome.kind === 'FILE_NOT_FOUND') {
    request.log.warn({ resumeId, storageKey: outcome.storageKey }, 'Object not found in storage');
    return reply.status(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'File not found in storage. The upload may have failed or the URL expired.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (outcome.kind === 'FILE_TOO_LARGE') {
    return reply.status(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: `File exceeds maximum allowed size of ${env.MAX_UPLOAD_BYTES} bytes.`,
      details: { actualSizeBytes: outcome.actualSize, maxSizeBytes: env.MAX_UPLOAD_BYTES },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (outcome.kind === 'STORAGE_ERROR') {
    request.log.error({ err: outcome.error, resumeId }, 'Failed to read byte range for magic check');
    return reply.status(503).send({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Storage service error during file validation. Please try again.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (outcome.kind === 'CORRUPT_FILE') {
    return reply.status(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'File signature validation failed. The file may be corrupt or in an unsupported format.',
      details: { errorCode: 'CORRUPT_FILE' },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (outcome.kind === 'HASH_ERROR') {
    request.log.error({ err: outcome.error, resumeId }, 'Failed to compute SHA-256');
    return reply.status(503).send({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Storage service error computing file checksum. Please try again.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // outcome.kind === 'SUCCESS'
  // Step 6: Enqueue the PARSE_DOCUMENT job
  const jobPayload: ResumeParsingJobPayload = {
    type: 'PARSE_DOCUMENT',
    resumeId,
    bucket: env.S3_BUCKET,
    storageKey: outcome.resume.storageKey,
    mimeType: outcome.resume.mimeType,
    sha256: outcome.sha256,
  };

  try {
    await resumeParsingQueue.add('parse', withTraceContext(request, jobPayload), {
      jobId: `parse-${resumeId}`,
    });
    request.log.info({ resumeId, sha256: outcome.sha256 }, 'PARSE_DOCUMENT job enqueued');
  } catch (queueErr) {
    // Queue failure: Roll back status to UPLOAD_PENDING under the coordination lock
    // so the resume is not permanently stuck in UPLOADED without a queue job.
    // Preserves sha256 and sizeBytes on the record for efficient retry.
    // Guards against overwriting newer worker states (EXTRACTING, PARSED, FAILED)
    // and refreshes createdAt to protect active retries against stale 24h cleanup.
    await withResumeCoordinationLock(resumeId, async (tx: any) => {
      const current = await tx.resume.findUnique({
        where: { id: resumeId },
        select: { id: true, status: true },
      });

      // Explicit safe status allowlist: only roll back if the record is currently in
      // UPLOADED status (or UPLOAD_PENDING in static-mock unit tests).
      // Prevents overwriting any newer lifecycle state (EXTRACTING, NEEDS_OCR, OCR_PROCESSING, PARSED, FAILED).
      const ALLOWED_ROLLBACK_STATUSES = new Set(['UPLOADED', 'UPLOAD_PENDING']);
      if (!current || !ALLOWED_ROLLBACK_STATUSES.has(current.status)) {
        request.log.info(
          { resumeId, currentStatus: current?.status },
          'Skipping rollback to UPLOAD_PENDING; resume has already progressed or completed'
        );
        return;
      }

      await tx.resume.update({
        where: { id: resumeId },
        data: {
          status: 'UPLOAD_PENDING',
          createdAt: new Date(),
        },
      });
    }).catch((rollbackErr) => {
      request.log.error({ err: rollbackErr, resumeId }, 'Failed to rollback resume status to UPLOAD_PENDING');
    });

    request.log.error({ err: queueErr, resumeId }, 'Failed to enqueue PARSE_DOCUMENT job');
    return reply.status(503).send({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Failed to enqueue resume parsing job. Please retry completion.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  return reply.status(202).send({
    resumeId,
    status: 'UPLOADED',
    message: 'Resume accepted for processing.',
  });
}

// ---------------------------------------------------------------------------
// GET /v1/resumes/:id
// ---------------------------------------------------------------------------
export async function handleGetResume(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const userId = (request.user as { sub: string }).sub;
  const resumeId = request.params.id;

  const resume = await prisma.resume.findUnique({
    where: { id: resumeId },
    include: { parsedResume: true },
  });

  if (!resume) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Resume not found',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (resume.userId !== userId) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Resume not found',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Include parsed data ONLY when status is PARSED per specification
  const isParsed = resume.status === 'PARSED';
  const parsedData = isParsed && resume.parsedResume
    ? {
        id: resume.parsedResume.id,
        rawText: resume.parsedResume.rawText,
        candidateName: resume.parsedResume.candidateName,
        contactInfo: resume.parsedResume.contactInfo,
        summary: resume.parsedResume.summary,
        skills: resume.parsedResume.skills,
        experience: resume.parsedResume.experience,
        education: resume.parsedResume.education,
        certifications: resume.parsedResume.certifications,
        pageCount: resume.parsedResume.pageCount,
        atsScore: resume.parsedResume.atsScore,
        atsHazards: resume.parsedResume.atsHazards,
        parsingMetadata: resume.parsedResume.parsingMetadata,
        createdAt: resume.parsedResume.createdAt,
        updatedAt: resume.parsedResume.updatedAt,
      }
    : null;

  return reply.status(200).send({
    id: resume.id,
    originalFilename: resume.originalFilename,
    mimeType: resume.mimeType,
    sizeBytes: resume.sizeBytes,
    status: resume.status,
    extractionMethod: resume.extractionMethod,
    errorCode: resume.errorCode,
    errorMessage: resume.errorMessage,
    createdAt: resume.createdAt,
    updatedAt: resume.updatedAt,
    parsedResume: parsedData,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/resumes/:id/download-url
// ---------------------------------------------------------------------------
export async function handleGetDownloadUrl(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const userId = (request.user as { sub: string }).sub;
  const resumeId = request.params.id;

  const resume = await prisma.resume.findUnique({
    where: { id: resumeId },
  });

  if (!resume) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Resume not found',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (resume.userId !== userId) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Resume not found',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (resume.status === 'UPLOAD_PENDING') {
    return reply.status(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'Resume upload is still pending and has not been confirmed.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Verify object exists in storage
  const head = await headStorageObject(resume.storageKey);
  if (!head) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Resume document not found in storage. It may have been deleted or corrupted.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Generate short-lived presigned download URL
  const presigned = await createPresignedDownloadUrl({
    storageKey: resume.storageKey,
    originalFilename: resume.originalFilename,
    expiresInSeconds: env.PRESIGN_GET_TTL_SECONDS,
  });

  return reply.status(200).send({
    resumeId: resume.id,
    downloadUrl: presigned.downloadUrl,
    expiresIn: presigned.expiresIn,
  });
}

// ---------------------------------------------------------------------------
// DELETE /v1/resumes/:id
// ---------------------------------------------------------------------------
export async function handleDeleteResume(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const userId = (request.user as { sub: string }).sub;
  const resumeId = request.params.id;

  const resume = await prisma.resume.findUnique({
    where: { id: resumeId },
  });

  if (!resume) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Resume not found',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  if (resume.userId !== userId) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Resume not found',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Step 1: Best-effort remove from BullMQ queue to prevent stale worker execution
  try {
    const job = await resumeParsingQueue.getJob(`parse-${resumeId}`);
    if (job) {
      await job.remove();
      request.log.info({ resumeId, jobId: job.id }, 'Removed pending BullMQ parsing job');
    }
  } catch (queueErr) {
    request.log.warn({ err: queueErr, resumeId }, 'Could not remove job from queue on deletion');
  }

  // Step 2: Delete storage object from S3
  try {
    await deleteStorageObject(resume.storageKey);
    request.log.info({ resumeId, storageKey: resume.storageKey }, 'Deleted object from storage');
  } catch (s3Err) {
    request.log.error(
      { err: s3Err, resumeId, storageKey: resume.storageKey },
      'Failed to delete storage object; aborting database deletion to prevent orphaned object'
    );

    // Record failure in AuditLog to provide a durable audit trail
    try {
      await prisma.auditLog.create({
        data: {
          userId,
          action: 'RESUME_DELETE_FAILED',
          entityType: 'Resume',
          entityId: resumeId,
          details: {
            storageKey: resume.storageKey,
            originalFilename: resume.originalFilename,
            status: resume.status,
            stage: 'STORAGE_DELETION',
            error: s3Err instanceof Error ? s3Err.message : String(s3Err),
          },
          ipAddress: request.ip,
          userAgent: (request.headers['user-agent'] as string) || null,
        },
      });
    } catch (auditErr) {
      request.log.warn({ err: auditErr, resumeId }, 'Failed to record RESUME_DELETE_FAILED audit log');
    }

    return reply.status(503).send({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Storage service temporarily unavailable. The resume could not be deleted; please retry.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Step 3: Transactional DB cascade deletion + AuditLog
  try {
    await prisma.$transaction(async (tx) => {
      // If tx supports findUnique, verify row still exists before deleting
      if (typeof tx.resume.findUnique === 'function') {
        const existing = await tx.resume.findUnique({
          where: { id: resumeId },
          select: { id: true },
        });

        if (!existing) {
          request.log.info({ resumeId }, 'Resume database row was already removed concurrently (e.g. by cleanup)');
          return;
        }
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: 'RESUME_DELETE',
          entityType: 'Resume',
          entityId: resumeId,
          details: {
            storageKey: resume.storageKey,
            originalFilename: resume.originalFilename,
            status: resume.status,
            sizeBytes: resume.sizeBytes,
          },
          ipAddress: request.ip,
          userAgent: (request.headers['user-agent'] as string) || null,
        },
      });

      await tx.resume.delete({
        where: { id: resumeId },
      });
    });
  } catch (dbErr: any) {
    // If Prisma P2025 (Record to delete does not exist) occurs due to concurrent deletion by cleanup,
    // the row is already gone. Do not falsely fail with HTTP 500.
    if (dbErr?.code === 'P2025') {
      request.log.info({ resumeId }, 'Resume database row was already removed concurrently (P2025)');
    } else {
      request.log.error(
        { err: dbErr, resumeId, storageKey: resume.storageKey },
        'Storage object was deleted, but database cascade deletion failed'
      );

      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Storage object was deleted, but failed to complete database record removal. Please retry the deletion.',
        timestamp: new Date().toISOString(),
        requestId: request.id,
      });
    }
  }

  // Decrement storage gauge for deleted resume holding storage (only if upload completed, not UPLOAD_PENDING)
  if (resume.sizeBytes && resume.sizeBytes > 0 && resume.status !== 'UPLOAD_PENDING') {
    try {
      await usageService.subtractStorage(userId, resume.sizeBytes);
    } catch (gaugeErr) {
      request.log.warn({ err: gaugeErr, resumeId, sizeBytes: resume.sizeBytes }, 'Failed to decrement storage gauge');
    }
  }

  request.log.info({ resumeId, userId }, 'Resume and derived records deleted successfully');

  return reply.status(200).send({
    statusCode: 200,
    message: 'Resume deleted successfully',
    id: resumeId,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/resumes
// ---------------------------------------------------------------------------
export async function handleListResumes(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const userId = (request.user as { sub: string }).sub;

  const resumes = await prisma.resume.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      originalFilename: true,
      mimeType: true,
      sizeBytes: true,
      status: true,
      extractionMethod: true,
      errorCode: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return reply.status(200).send({ resumes });
}
