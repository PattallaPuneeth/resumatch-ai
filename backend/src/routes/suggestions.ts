import crypto from 'crypto';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env, scaledRateLimit } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { redisClient } from '../queues/redis.js';
import { withMeter } from '../services/meterGuard.js';
import {
  jobSuggestionsBodySchema,
  type JobSuggestionsBody,
  type RawJobListing,
  type ScoredJobSuggestion,
  type JobSuggestionsResponse,
} from '../services/jobSource/types.js';
import { getJobSource, getJobSourceQueryCap, getJobSourceAllowlist } from '../services/jobSource/factory.js';
import { deriveJobSearchQueries } from '../services/jobSource/queryBuilder.js';

interface CacheEntry {
  data: JobSuggestionsResponse;
  expiresAt: number;
}

const localSuggestionsCache = new Map<string, CacheEntry>();

export async function clearSuggestionsCache(): Promise<void> {
  localSuggestionsCache.clear();
  try {
    const keys = await redisClient.keys('suggestions:*');
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  } catch {
    // Non-blocking
  }
}

export const suggestionsParamsSchema = z.object({
  id: z.string().uuid('Invalid resume UUID'),
});

interface MlScoreResponseItem {
  id: string;
  title: string;
  company: string;
  location: string | null;
  sourceUrl: string;
  matchScore: number;
  matchedSkills: string[];
  missingSkills: string[];
}

interface MlScoreApiResponse {
  resumeId: string;
  totalScored: number;
  results: MlScoreResponseItem[];
}

/**
 * Job suggestions route (Phase 7).
 * POST /v1/resumes/:id/suggestions
 * Provides intelligent job suggestions powered by swappable JobSource
 * and scored deterministically by the Phase 3 ML matching pipeline.
 */
export const suggestionsRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>(
    '/v1/resumes/:id/suggestions',
    {
      config: {
        rateLimit: {
          max: scaledRateLimit(20),
          timeWindow: '1 minute',
        },
      },
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user as any;
      const userId: string = user?.userId || user?.sub;

      // 1. Parameter Validation
      const paramsParse = suggestionsParamsSchema.safeParse(request.params);
      if (!paramsParse.success) {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/validation-error',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: paramsParse.error.errors.map((e) => e.message).join('; '),
          detail: paramsParse.error.errors.map((e) => e.message).join('; '),
        });
      }

      const { id: resumeId } = paramsParse.data;

      // 2. Body Validation
      const bodyParse = jobSuggestionsBodySchema.safeParse(request.body || {});
      if (!bodyParse.success) {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/validation-error',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: bodyParse.error.errors.map((e) => e.message).join('; '),
          detail: bodyParse.error.errors.map((e) => e.message).join('; '),
        });
      }

      const body: JobSuggestionsBody = bodyParse.data;
      const limit = body.limit ?? 10;

      // 3. Resume Ownership & IDOR Protection (404 convention)
      const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
      if (!resume || resume.userId !== userId) {
        return reply.status(404).send({
          type: 'https://api.resumatch.ai/errors/not-found',
          title: 'Not Found',
          status: 404,
          statusCode: 404,
          error: 'Not Found',
          message: 'Resume not found',
          detail: 'Resume not found',
        });
      }

      // 4. If target jobId is provided, verify job ownership (404 convention)
      let targetJob = null;
      if (body.jobId) {
        targetJob = await prisma.job.findUnique({ where: { id: body.jobId } });
        if (!targetJob || targetJob.userId !== userId) {
          return reply.status(404).send({
            type: 'https://api.resumatch.ai/errors/not-found',
            title: 'Not Found',
            status: 404,
            statusCode: 404,
            error: 'Not Found',
            message: 'Target job not found',
            detail: 'Target job not found',
          });
        }
      }

      // 5. Verify Resume Status is PARSED
      if (resume.status !== 'PARSED') {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/invalid-state',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: `Resume must be in PARSED status to receive job suggestions. Current status: ${resume.status}`,
          detail: `Resume must be in PARSED status to receive job suggestions. Current status: ${resume.status}`,
        });
      }

      // 6. Verify ParsedResume exists
      const parsedResume = await prisma.parsedResume.findUnique({ where: { resumeId } });
      if (!parsedResume || !parsedResume.rawText) {
        return reply.status(422).send({
          type: 'https://api.resumatch.ai/errors/no-text',
          title: 'Unprocessable Entity',
          status: 422,
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'Parsed resume text is missing or empty',
          detail: 'Parsed resume text is missing or empty',
        });
      }

      // 7. Metering Guard: consume 1 unit of job_suggestions atomically before expensive search
      await withMeter(request, reply, 'job_suggestions', async () => {
        // Deterministic cache key for identical requests
        const rawTextHash = crypto
          .createHash('sha256')
          .update(parsedResume.rawText)
          .digest('hex')
          .slice(0, 16);
        const cacheKey = `suggestions:${resumeId}:${crypto
          .createHash('sha256')
          .update(
            JSON.stringify({
              jobId: body.jobId || null,
              location: body.location || null,
              seniority: body.seniority || null,
              limit,
              rawTextHash,
            })
          )
          .digest('hex')}`;

        // 1. Check in-memory local cache
        const localEntry = localSuggestionsCache.get(cacheKey);
        if (localEntry && localEntry.expiresAt > Date.now()) {
          request.log.info({ cacheKey }, 'Suggestions cache hit (memory)');
          return reply.status(200).send(localEntry.data);
        }

        // 2. Check Redis cache
        try {
          const redisVal = await redisClient.get(cacheKey);
          if (redisVal) {
            const parsed = JSON.parse(redisVal);
            localSuggestionsCache.set(cacheKey, {
              data: parsed,
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            });
            request.log.info({ cacheKey }, 'Suggestions cache hit (Redis)');
            return reply.status(200).send(parsed);
          }
        } catch {
          // Redis cache miss or disconnected, proceed to search
        }

        // Derive queries based on mode (without JD vs with JD) and clamp by hard queryCap
        const derivedQueries = deriveJobSearchQueries({
          parsedResume,
          targetJob,
          location: body.location,
          seniority: body.seniority,
        });

        const queryCap = getJobSourceQueryCap();
        const queries = derivedQueries.slice(0, queryCap);
        const jobSource = getJobSource();
        const allowlist = getJobSourceAllowlist();
        const searchLimit = Math.min(limit, 3);

        request.log.info(
          {
            queryCount: queries.length,
            limit: searchLimit,
            queryCap,
            jobSource: jobSource.type,
          },
          'Executing JobSource suggestions search'
        );

        const candidateListings: RawJobListing[] = [];
        const seenUrls = new Set<string>();
        const seenKeys = new Set<string>();

        // Execute queries and cache listings
        for (const queryStr of queries) {
          let listings: RawJobListing[] = [];
          try {
            listings = await jobSource.searchJobs(
              {
                query: queryStr,
                location: body.location,
                seniority: body.seniority,
                limit: searchLimit,
              },
              { allowlist, timeoutMs: 15000, maxResults: searchLimit }
            );
          } catch (sourceErr: any) {
            request.log.error({ err: sourceErr, query: queryStr }, 'JobSource search execution failed');
            // Re-throw so withMeter refunds quota and emits 502/500 error
            throw new Error(`Job source search failed: ${sourceErr.message || sourceErr}`);
          }

          for (const listing of listings) {
            // Deduplicate by URL hash
            if (seenUrls.has(listing.urlHash)) continue;
            seenUrls.add(listing.urlHash);

            // Deduplicate by composite key (title + company + location)
            const dedupeKey = `${listing.title.toLowerCase()}|${listing.company.toLowerCase()}|${(listing.location || '').toLowerCase()}`;
            if (seenKeys.has(dedupeKey)) continue;
            seenKeys.add(dedupeKey);

            candidateListings.push(listing);

            // Asynchronously update/insert into JobListingCache with 24-hour TTL
            try {
              const ttlDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
              await prisma.jobListingCache.upsert({
                where: { urlHash: listing.urlHash },
                create: {
                  urlHash: listing.urlHash,
                  contentHash: listing.contentHash,
                  sourceUrl: listing.sourceUrl,
                  title: listing.title,
                  company: listing.company,
                  location: listing.location,
                  cleanedText: listing.cleanedText,
                  expiresAt: ttlDate,
                },
                update: {
                  contentHash: listing.contentHash,
                  title: listing.title,
                  company: listing.company,
                  location: listing.location,
                  cleanedText: listing.cleanedText,
                  expiresAt: ttlDate,
                },
              });
            } catch (cacheErr) {
              request.log.warn({ err: cacheErr, urlHash: listing.urlHash }, 'Failed to write listing to cache');
            }
          }

          if (candidateListings.length >= limit * 2) {
            break;
          }
        }

        // If no listings found, return 200 with empty suggestions
        if (candidateListings.length === 0) {
          const emptyResponse: JobSuggestionsResponse = {
            resumeId,
            totalFound: 0,
            suggestions: [],
            message: 'No matching job suggestions found for the provided criteria.',
            source: jobSource.type,
            isSample: jobSource.type === 'mock',
          };
          localSuggestionsCache.set(cacheKey, {
            data: emptyResponse,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          try {
            await redisClient.set(cacheKey, JSON.stringify(emptyResponse), 'EX', 86400);
          } catch {
            // Non-blocking
          }
          return reply.status(200).send(emptyResponse);
        }

        // Invoke ML Service matching endpoint to score candidate listings
        let scoredResults: MlScoreResponseItem[] = [];
        try {
          const mlUrl = `${env.ML_SERVICE_URL}/v1/matching/score-listings`;
          const mlPayload = {
            resumeId,
            listings: candidateListings.map((l) => ({
              id: l.id || l.urlHash,
              title: l.title,
              company: l.company,
              location: l.location,
              description: l.cleanedText,
              sourceUrl: l.sourceUrl,
            })),
          };

          const mlRes = await fetch(mlUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Token': env.INTERNAL_API_TOKEN,
            },
            body: JSON.stringify(mlPayload),
          });

          if (!mlRes.ok) {
            const errText = await mlRes.text().catch(() => '');
            request.log.error({ status: mlRes.status, body: errText }, 'ML service scoring failed');
            throw new Error(`ML scoring service failed with HTTP ${mlRes.status}: ${errText}`);
          }

          const mlData = (await mlRes.json()) as MlScoreApiResponse;
          scoredResults = mlData.results || [];
        } catch (mlErr: any) {
          request.log.error({ err: mlErr }, 'Failed to invoke ML scoring pipeline');
          throw mlErr; // triggers withMeter refund
        }

        // Map and sort suggestions
        const listingMap = new Map<string, RawJobListing>();
        for (const l of candidateListings) {
          listingMap.set(l.id || l.urlHash, l);
        }

        const formattedSuggestions: ScoredJobSuggestion[] = scoredResults
          .slice(0, limit)
          .map((s) => {
            const original = listingMap.get(s.id);
            return {
              title: s.title,
              company: s.company,
              location: s.location || null,
              sourceUrl: s.sourceUrl,
              matchScore: s.matchScore,
              matchedSkills: s.matchedSkills || [],
              missingSkills: s.missingSkills || [],
              fetchedAt: original?.fetchedAt || new Date().toISOString(),
            };
          });

        const finalResponse: JobSuggestionsResponse = {
          resumeId,
          totalFound: formattedSuggestions.length,
          suggestions: formattedSuggestions,
          source: jobSource.type,
          isSample: jobSource.type === 'mock',
        };

        // Cache final response in memory and Redis (24-hour TTL)
        localSuggestionsCache.set(cacheKey, {
          data: finalResponse,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        });
        try {
          await redisClient.set(cacheKey, JSON.stringify(finalResponse), 'EX', 86400);
        } catch {
          // Non-blocking
        }

        return reply.status(200).send(finalResponse);
      });
    }
  );
};
