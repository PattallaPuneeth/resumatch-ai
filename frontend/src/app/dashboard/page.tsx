'use client';

import React, { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/authContext';
import { apiClient, ResumeSummary, UserUsageResponse } from '@/lib/apiClient';
import { UsagePanel } from '@/components/UsagePanel';
import { ResumeUpload } from '@/components/ResumeUpload';
import { ResumeList } from '@/components/ResumeList';
import { BulletEditor } from '@/components/BulletEditor';
import { Loader2 } from 'lucide-react';

export default function DashboardPage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/login?next=/dashboard');
    }
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    document.title = 'Dashboard | ResuMatch AI';
  }, []);

  // Fetch user's resumes
  const { data: resumesData } = useQuery<{ resumes: ResumeSummary[] }>({
    queryKey: ['resumes'],
    queryFn: () => apiClient.resumes.list(),
    enabled: isAuthenticated,
  });

  const resumes = useMemo(() => resumesData?.resumes || [], [resumesData?.resumes]);
  const firstParsed = useMemo(() => resumes.find((r) => r.status === 'PARSED'), [resumes]);

  // Fetch usage meters
  const { data: usageData, refetch: refetchUsage } = useQuery<UserUsageResponse>({
    queryKey: ['usage'],
    queryFn: () => apiClient.usage.get(),
    enabled: isAuthenticated,
  });

  // Fetch active parsed resume detail to extract experience bullets
  const { data: resumeDetailData } = useQuery({
    queryKey: ['resume-detail', firstParsed?.id],
    queryFn: () => apiClient.resumes.get(firstParsed!.id),
    enabled: !!firstParsed?.id,
  });

  const resumeBullets = useMemo(() => {
    if (!resumeDetailData?.parsedResume) return [];
    const exp = (resumeDetailData.parsedResume as any).experience || [];
    const bullets: string[] = [];
    exp.forEach((job: any) => {
      if (Array.isArray(job.bullets)) {
        bullets.push(...job.bullets.filter(Boolean));
      }
    });
    return bullets;
  }, [resumeDetailData]);

  if (isLoading || !isAuthenticated) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground font-medium">Verifying session...</span>
      </div>
    );
  }

  const handleUploadSuccess = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['resumes'] }),
      queryClient.invalidateQueries({ queryKey: ['usage'] }),
    ]);
  };

  const handleDeleteSuccess = async () => {
    await queryClient.invalidateQueries({ queryKey: ['usage'] });
  };

  return (
    <div className="container mx-auto px-4 sm:px-6 py-8 max-w-7xl space-y-10 animate-in fade-in duration-300" data-testid="dashboard-page">
      {/* Welcome Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-950">
            Welcome back, <span className="text-primary">{user?.username}</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-1">
            Manage your resumes, track object storage consumption, and evaluate ATS compatibility.
          </p>
        </div>
      </div>

      {/* Usage Panel (REQUIRED ON DASHBOARD) */}
      <UsagePanel />

      {/* Upload Dropzone */}
      <section aria-label="Resume upload section">
        <ResumeUpload onUploadSuccess={handleUploadSuccess} />
      </section>

      {/* Resume Management List */}
      <section aria-label="Uploaded resumes repository">
        <ResumeList onDeleteSuccess={handleDeleteSuccess} />
      </section>

      {/* Interactive Bullet Rewriter Mounted on Dashboard per Requirement A2 */}
      {firstParsed && (
        <section aria-label="Quick STAR bullet rewriter" className="pt-2">
          <BulletEditor
            resumeId={firstParsed.id}
            bullets={resumeBullets}
            analysesMeter={usageData?.meters?.analyses}
            onUsageChange={refetchUsage}
          />
        </section>
      )}
    </div>
  );
}
