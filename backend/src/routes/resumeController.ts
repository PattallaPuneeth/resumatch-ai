import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import {
  buildStorageKey,
  createPresignedUploadUrl,
  headStorageObject,
  getStorageObjectByteRange,
  deleteStorageObject,
} from '../storage/s3.js';
import { resumeParsingQueue } from '../queues/bullmq.js';
import type { ResumeParsingJobPayload } from '../queues/bullmq.js';
import { env } from '../config/env.js';

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

  // Fetch the resume and verify ownership
  const resume = await prisma.resume.findUnique({ where: { id: resumeId } });

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
    return reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'You do not have permission to access this resume',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Idempotency: if already progressed to worker pipeline (Phase 2C), do not re-enqueue
  if (resume.status === 'EXTRACTING' ||
      resume.status === 'NEEDS_OCR' || resume.status === 'OCR_PROCESSING' ||
      resume.status === 'PARSED') {
    request.log.info({ resumeId, status: resume.status }, 'Idempotent complete call — already in worker pipeline');
    return reply.status(202).send({
      resumeId,
      status: resume.status,
      message: 'Resume already accepted for processing',
    });
  }

  // Idempotency: if resume was marked UPLOADED, ensure the BullMQ job is active.
  // BullMQ deduplicates on jobId: if already queued or active, this is a safe no-op.
  if (resume.status === 'UPLOADED') {
    const jobPayload: ResumeParsingJobPayload = {
      type: 'PARSE_DOCUMENT',
      resumeId: resume.id,
      bucket: env.S3_BUCKET,
      storageKey: resume.storageKey,
      mimeType: resume.mimeType,
      sha256: resume.sha256 || undefined,
    };

    try {
      await resumeParsingQueue.add('parse', jobPayload, {
        jobId: `parse-${resume.id}`,
      });
      request.log.info({ resumeId, status: resume.status }, 'Idempotent complete call — ensured parse job in queue');
      return reply.status(202).send({
        resumeId,
        status: resume.status,
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

  if (resume.status === 'FAILED') {
    return reply.status(409).send({
      statusCode: 409,
      error: 'Conflict',
      message: 'Resume is in a FAILED state and cannot be reprocessed. Please upload a new file.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Should be UPLOAD_PENDING at this point
  if (resume.status !== 'UPLOAD_PENDING') {
    return reply.status(409).send({
      statusCode: 409,
      error: 'Conflict',
      message: `Resume is in an unexpected state: ${resume.status}`,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Step 1: Verify the object exists in storage
  const headResult = await headStorageObject(resume.storageKey);
  if (!headResult) {
    request.log.warn({ resumeId, storageKey: resume.storageKey }, 'Object not found in storage');
    return reply.status(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'File not found in storage. The upload may have failed or the URL expired.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Step 2: Enforce actual object size, not client-declared size
  const actualSize = headResult.contentLength;
  if (actualSize > env.MAX_UPLOAD_BYTES) {
    // Mark FAILED and delete the oversized object
    await prisma.resume.update({
      where: { id: resumeId },
      data: {
        status: 'FAILED',
        errorCode: 'FILE_TOO_LARGE',
        errorMessage: `Uploaded file (${actualSize} bytes) exceeds the maximum allowed size of ${env.MAX_UPLOAD_BYTES} bytes.`,
      },
    });
    await deleteStorageObject(resume.storageKey).catch(() => {});
    return reply.status(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: `File exceeds maximum allowed size of ${env.MAX_UPLOAD_BYTES} bytes.`,
      details: { actualSizeBytes: actualSize, maxSizeBytes: env.MAX_UPLOAD_BYTES },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Step 3: Validate magic bytes
  const ext = resume.mimeType === 'application/pdf' ? 'pdf' : 'docx';
  const magic = MAGIC_BYTES[ext];
  let byteRange: Buffer;
  try {
    byteRange = await getStorageObjectByteRange(resume.storageKey, 0, magic.bytes.length - 1);
  } catch (rangeErr) {
    request.log.error({ err: rangeErr, resumeId }, 'Failed to read byte range for magic check');
    return reply.status(503).send({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Storage service error during file validation. Please try again.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  const magicMatch = byteRange.length >= magic.bytes.length &&
    byteRange.subarray(0, magic.bytes.length).equals(magic.bytes);

  if (!magicMatch) {
    // File is corrupt or wrong type — mark FAILED and delete
    await prisma.resume.update({
      where: { id: resumeId },
      data: {
        status: 'FAILED',
        errorCode: 'CORRUPT_FILE',
        errorMessage: `The uploaded file does not match the expected format (expected ${magic.description} magic bytes).`,
      },
    });
    await deleteStorageObject(resume.storageKey).catch(() => {});
    return reply.status(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'File signature validation failed. The file may be corrupt or in an unsupported format.',
      details: { errorCode: 'CORRUPT_FILE' },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Step 4: Compute SHA-256 using a larger byte range for hash accuracy.
  // We use the full object via a stream-friendly ranged read for hashing.
  // Note: for large files we read enough to compute hash robustly.
  // The spec says "Calculate SHA-256 and persist it."
  // We use the ETag if it's an MD5, otherwise compute from the first block.
  // For correctness we read up to MAX_UPLOAD_BYTES in one ranged GET.
  let sha256: string;
  try {
    const fullBytes = await getStorageObjectByteRange(resume.storageKey, 0, env.MAX_UPLOAD_BYTES - 1);
    sha256 = createHash('sha256').update(fullBytes).digest('hex');
  } catch (hashErr) {
    request.log.error({ err: hashErr, resumeId }, 'Failed to compute SHA-256');
    return reply.status(503).send({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Storage service error computing file checksum. Please try again.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  }

  // Step 5: Transition to UPLOADED, persist sha256 and actual size
  await prisma.resume.update({
    where: { id: resumeId },
    data: {
      status: 'UPLOADED',
      sha256,
      sizeBytes: actualSize,
    },
  });

  // Step 6: Enqueue the PARSE_DOCUMENT job
  const jobPayload: ResumeParsingJobPayload = {
    type: 'PARSE_DOCUMENT',
    resumeId,
    bucket: env.S3_BUCKET,
    storageKey: resume.storageKey,
    mimeType: resume.mimeType,
    sha256,
  };

  try {
    await resumeParsingQueue.add('parse', jobPayload, {
      jobId: `parse-${resumeId}`, // Idempotency: same resumeId gets same jobId
    });
    request.log.info({ resumeId, sha256 }, 'PARSE_DOCUMENT job enqueued');
  } catch (queueErr) {
    // Queue failure: Roll back status to UPLOAD_PENDING so the resume is not permanently stuck
    // in UPLOADED without a queue job. Preserves sha256 and sizeBytes on the record for efficient retry.
    await prisma.resume.update({
      where: { id: resumeId },
      data: {
        status: 'UPLOAD_PENDING',
      },
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
