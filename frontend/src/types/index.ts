/**
 * ResuMatch AI - Strongly-typed API Contracts
 * Generated from backend OpenAPI 3.0 route schemas.
 */
export type { paths } from './api.generated.js';
import type { paths } from './api.generated.js';

export type HealthResponse = NonNullable<paths['/health']['get']['responses'][200]['content']>['application/json'];
export type CreateJobRequest = paths['/v1/jobs']['post']['requestBody']['content']['application/json'];
export type RewriteBulletRequest = paths['/v1/rewriter/bullet']['post']['requestBody']['content']['application/json'];
export type UploadUrlRequest = paths['/v1/resumes/upload-url']['post']['requestBody']['content']['application/json'];
