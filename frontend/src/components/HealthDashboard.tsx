'use client';

import React from 'react';
import { Activity, CheckCircle2, XCircle, RefreshCw, Database, Server, Cpu, HardDrive } from 'lucide-react';
import { useBackendHealth } from '@/hooks/useHealth';

export function HealthDashboard() {
  const backendQuery = useBackendHealth();
  const isLoading = backendQuery.isLoading;
  const isHealthy = backendQuery.data?.status === 'healthy';

  const refetchAll = () => {
    backendQuery.refetch();
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Infrastructure & Cluster Telemetry
          </h2>
          <p className="text-sm text-muted-foreground">Live operational telemetry via same-origin backend health probe</p>
        </div>
        <button
          onClick={refetchAll}
          disabled={isLoading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-card hover:bg-slate-100 text-foreground transition-colors border border-border disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Fastify Backend Service Card */}
        <div className="rounded-xl p-5 border border-border bg-card shadow-sm">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-emerald-50 text-primary border border-emerald-200">
                <Server className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">Fastify API Gateway</h3>
                <p className="text-xs text-muted-foreground">Node.js Strict TypeScript • /health Probe</p>
              </div>
            </div>
            {isLoading ? (
              <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-muted-foreground animate-pulse">
                Probing...
              </span>
            ) : isHealthy ? (
              <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Operational
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                <XCircle className="h-3.5 w-3.5" />
                Degraded
              </span>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-border space-y-2 text-xs">
            <div className="flex justify-between items-center text-foreground">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Cpu className="h-3.5 w-3.5" /> Redis 7 (BullMQ Queue)
              </span>
              <span className={backendQuery.data?.services.redis.status === 'healthy' ? 'text-emerald-700 font-medium' : 'text-rose-700'}>
                {backendQuery.data?.services.redis.status ?? 'Probing...'}
                {backendQuery.data?.services.redis.latencyMs !== undefined ? ` (${backendQuery.data.services.redis.latencyMs}ms)` : ''}
              </span>
            </div>

            <div className="flex justify-between items-center text-foreground">
              <span className="text-muted-foreground">Gateway Version</span>
              <span className="font-mono text-muted-foreground">{backendQuery.data?.version ?? '1.0.0'}</span>
            </div>
          </div>
        </div>

        {/* Database & Storage Persistence Card */}
        <div className="rounded-xl p-5 border border-border bg-card shadow-sm">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-emerald-50 text-primary border border-emerald-200">
                <Database className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">Persistent Storage Subsystems</h3>
                <p className="text-xs text-muted-foreground">PostgreSQL 16 & MinIO S3</p>
              </div>
            </div>
            {isLoading ? (
              <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-muted-foreground animate-pulse">
                Probing...
              </span>
            ) : isHealthy ? (
              <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Operational
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                <XCircle className="h-3.5 w-3.5" />
                Degraded
              </span>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-border space-y-2 text-xs">
            <div className="flex justify-between items-center text-foreground">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Database className="h-3.5 w-3.5" /> PostgreSQL pgvector
              </span>
              <span className={backendQuery.data?.services.postgres.status === 'healthy' ? 'text-emerald-700 font-medium' : 'text-rose-700'}>
                {backendQuery.data?.services.postgres.status ?? 'Probing...'}
                {backendQuery.data?.services.postgres.latencyMs !== undefined ? ` (${backendQuery.data.services.postgres.latencyMs}ms)` : ''}
              </span>
            </div>

            <div className="flex justify-between items-center text-foreground">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <HardDrive className="h-3.5 w-3.5" /> MinIO S3 Storage
              </span>
              <span className={backendQuery.data?.services.minio.status === 'healthy' ? 'text-emerald-700 font-medium' : 'text-rose-700'}>
                {backendQuery.data?.services.minio.status ?? 'Probing...'}
                {backendQuery.data?.services.minio.latencyMs !== undefined ? ` (${backendQuery.data.services.minio.latencyMs}ms)` : ''}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
