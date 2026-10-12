'use client';

import { Activity, CheckCircle2, XCircle, RefreshCw, Database, Server, Cpu, HardDrive } from 'lucide-react';
import { useBackendHealth, useMLHealth } from '@/hooks/useHealth';

export function HealthDashboard() {
  const backendQuery = useBackendHealth();
  const mlQuery = useMLHealth();

  const isBackendLoading = backendQuery.isLoading;
  const isMLLoading = mlQuery.isLoading;

  const backendHealthy = backendQuery.data?.status === 'healthy';
  const mlHealthy = mlQuery.data?.status === 'OK';

  const refetchAll = () => {
    backendQuery.refetch();
    mlQuery.refetch();
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <Activity className="h-5 w-5 text-blue-400" />
            Infrastructure & Cluster Health
          </h2>
          <p className="text-sm text-slate-400">Live operational telemetry across ResuMatch AI microservices</p>
        </div>
        <button
          onClick={refetchAll}
          disabled={isBackendLoading || isMLLoading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors border border-slate-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isBackendLoading || isMLLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Fastify Backend Service Card */}
        <div className="glass-panel rounded-xl p-5 border border-slate-800 bg-slate-900/60 shadow-xl">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
                <Server className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-white">Fastify API Gateway</h3>
                <p className="text-xs text-slate-400">Node.js • TypeScript Strict • Port 4000</p>
              </div>
            </div>
            {isBackendLoading ? (
              <span className="text-xs px-2.5 py-1 rounded-full bg-slate-800 text-slate-400 animate-pulse">
                Probing...
              </span>
            ) : backendHealthy ? (
              <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Operational
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
                <XCircle className="h-3.5 w-3.5" />
                Degraded
              </span>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-slate-800/80 space-y-2 text-xs">
            <div className="flex justify-between items-center text-slate-300">
              <span className="flex items-center gap-1.5 text-slate-400">
                <Database className="h-3.5 w-3.5" /> PostgreSQL pgvector
              </span>
              <span className={backendQuery.data?.services.postgres.status === 'healthy' ? 'text-emerald-400' : 'text-rose-400'}>
                {backendQuery.data?.services.postgres.status ?? 'Offline'}
                {backendQuery.data?.services.postgres.latencyMs ? ` (${backendQuery.data.services.postgres.latencyMs}ms)` : ''}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-300">
              <span className="flex items-center gap-1.5 text-slate-400">
                <Cpu className="h-3.5 w-3.5" /> Redis 7 (BullMQ)
              </span>
              <span className={backendQuery.data?.services.redis.status === 'healthy' ? 'text-emerald-400' : 'text-rose-400'}>
                {backendQuery.data?.services.redis.status ?? 'Offline'}
                {backendQuery.data?.services.redis.latencyMs ? ` (${backendQuery.data.services.redis.latencyMs}ms)` : ''}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-300">
              <span className="flex items-center gap-1.5 text-slate-400">
                <HardDrive className="h-3.5 w-3.5" /> MinIO S3 Storage
              </span>
              <span className={backendQuery.data?.services.minio.status === 'healthy' ? 'text-emerald-400' : 'text-rose-400'}>
                {backendQuery.data?.services.minio.status ?? 'Offline'}
                {backendQuery.data?.services.minio.latencyMs ? ` (${backendQuery.data.services.minio.latencyMs}ms)` : ''}
              </span>
            </div>
          </div>
        </div>

        {/* FastAPI ML Microservice Card */}
        <div className="glass-panel rounded-xl p-5 border border-slate-800 bg-slate-900/60 shadow-xl">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20">
                <Cpu className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-white">FastAPI ML Engine</h3>
                <p className="text-xs text-slate-400">Python 3.11 • PyTorch • Port 8000</p>
              </div>
            </div>
            {isMLLoading ? (
              <span className="text-xs px-2.5 py-1 rounded-full bg-slate-800 text-slate-400 animate-pulse">
                Probing...
              </span>
            ) : mlHealthy ? (
              <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Operational
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
                <XCircle className="h-3.5 w-3.5" />
                Degraded
              </span>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-slate-800/80 space-y-2 text-xs">
            <div className="flex justify-between items-center text-slate-300">
              <span className="flex items-center gap-1.5 text-slate-400">
                <Database className="h-3.5 w-3.5" /> Raw psycopg DB Probe
              </span>
              <span className={mlQuery.data?.dependencies.postgres.status === 'healthy' ? 'text-emerald-400' : 'text-rose-400'}>
                {mlQuery.data?.dependencies.postgres.status ?? 'Offline'}
                {mlQuery.data?.dependencies.postgres.latency_ms ? ` (${mlQuery.data.dependencies.postgres.latency_ms}ms)` : ''}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-300">
              <span className="text-slate-400">pgvector Extension</span>
              <span className="text-blue-400 font-mono">
                {mlQuery.data?.dependencies.postgres.pgvector_extension ?? 'vector(384)'}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-300">
              <span className="text-slate-400">Embedding Standard</span>
              <span className="text-purple-400 font-mono">all-MiniLM-L6-v2 (384d)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
