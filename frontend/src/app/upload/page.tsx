'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  UploadCloud,
  FileText,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  X,
  Key,
  ShieldCheck,
  Download,
  Trash2,
  Award,
  AlertTriangle,
  Briefcase,
  GraduationCap,
  Layers,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import { HealthDashboard } from '@/components/HealthDashboard';
import {
  api,
  ApiException,
  UploadUrlResponse,
  CompleteUploadResponse,
  ResumeDetailsResponse,
  ListResumesResponse,
} from '@/lib/api';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB per specification

type UploadStep =
  | 'idle'
  | 'requesting_url'
  | 'uploading'
  | 'confirming'
  | 'processing'
  | 'success'
  | 'error';

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [token, setToken] = useState<string>('');
  const [showTokenInput, setShowTokenInput] = useState(false);

  // Upload state
  const [step, setStep] = useState<UploadStep>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(null);

  // Processing & Parsed State (Phase 2D)
  const [resumeDetails, setResumeDetails] = useState<ResumeDetailsResponse | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // My Resumes List
  const [myResumes, setMyResumes] = useState<ListResumesResponse['resumes']>([]);
  const [isLoadingResumes, setIsLoadingResumes] = useState(false);

  // Contract probe state
  const [stubStatus, setStubStatus] = useState<string | null>(null);
  const [isCallingStub, setIsCallingStub] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Load saved token from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('resumatch_auth_token');
    if (saved) {
      setToken(saved);
    }
  }, []);

  const handleTokenChange = (val: string) => {
    setToken(val);
    localStorage.setItem('resumatch_auth_token', val);
  };

  const loadUserResumes = useCallback(async () => {
    if (!token.trim()) return;
    setIsLoadingResumes(true);
    try {
      const res = await api.listResumes(token.trim());
      setMyResumes(res.resumes);
    } catch {
      // Ignored for unauthenticated or first load
    } finally {
      setIsLoadingResumes(false);
    }
  }, [token]);

  useEffect(() => {
    if (token.trim()) {
      loadUserResumes();
    }
  }, [token, loadUserResumes]);

  // Clean up poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  const validateFile = (selectedFile: File): string | null => {
    const ext = selectedFile.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pdf' && ext !== 'docx') {
      return 'Only PDF and DOCX files are supported.';
    }
    if (selectedFile.size > MAX_UPLOAD_BYTES) {
      return `File size (${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB) exceeds the 5 MB limit.`;
    }
    return null;
  };

  const handleFileSelect = (selectedFile: File) => {
    setErrorMessage(null);
    setErrorDetails(null);
    setErrorCode(null);
    setResumeDetails(null);

    const validationError = validateFile(selectedFile);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setFile(selectedFile);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (step !== 'idle') return;
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (step !== 'idle') return;

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  // Status Poller
  const startStatusPolling = (targetResumeId: string, authToken: string) => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    let pollCount = 0;
    const maxPolls = 40; // 40 * 1.5s = 60s timeout

    pollTimerRef.current = setInterval(async () => {
      pollCount++;
      try {
        const details = await api.getResume(targetResumeId, authToken);
        setResumeDetails(details);

        if (details.status === 'PARSED') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setStep('success');
          loadUserResumes();
        } else if (details.status === 'FAILED') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setStep('error');
          setErrorCode(details.errorCode || 'INTERNAL_ERROR');
          setErrorMessage(
            details.errorMessage || 'Parsing failed due to an unrecoverable document issue.'
          );
          loadUserResumes();
        } else if (pollCount >= maxPolls) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setStep('error');
          setErrorMessage('Parsing timed out. Please check back later.');
        }
      } catch (err) {
        if (pollCount >= maxPolls) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setStep('error');
          setErrorMessage('Failed to retrieve processing status.');
        }
      }
    }, 1500);
  };

  const handleUpload = async () => {
    if (!file) return;

    if (!token.trim()) {
      setShowTokenInput(true);
      setErrorMessage('Authentication token is required. Please provide a JWT Bearer token.');
      return;
    }

    setErrorMessage(null);
    setErrorDetails(null);
    setErrorCode(null);
    setUploadProgress(0);

    let mimeType = file.type;
    if (!mimeType) {
      mimeType = file.name.endsWith('.pdf')
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }

    try {
      // Step 1: Request presigned upload URL
      setStep('requesting_url');
      const urlResponse: UploadUrlResponse = await api.requestUploadUrl(
        {
          filename: file.name,
          mimeType,
          sizeBytes: file.size,
        },
        token.trim()
      );

      setResumeId(urlResponse.resumeId);

      // Step 2: Direct upload to storage
      setStep('uploading');
      await api.uploadToStorage(
        urlResponse.uploadUrl,
        file,
        urlResponse.headers,
        (percent) => setUploadProgress(percent)
      );

      // Step 3: Complete upload and trigger ingestion pipeline
      setStep('confirming');
      await api.completeUpload(urlResponse.resumeId, token.trim());

      // Step 4: Poll status transitions (Phase 2D)
      setStep('processing');
      startStatusPolling(urlResponse.resumeId, token.trim());
    } catch (err: unknown) {
      setStep('error');
      if (err instanceof ApiException) {
        setErrorMessage(`Upload failed (${err.errorName}): ${err.message}`);
        if (err.details) {
          setErrorDetails(JSON.stringify(err.details, null, 2));
        }
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('An unexpected error occurred during upload.');
      }
    }
  };

  const handleDownload = async (targetId?: string) => {
    const id = targetId || resumeId;
    if (!id || !token.trim()) return;

    setIsDownloading(true);
    try {
      const res = await api.getResumeDownloadUrl(id, token.trim());
      // Trigger browser download via presigned GET
      const link = document.createElement('a');
      link.href = res.downloadUrl;
      link.setAttribute('download', resumeDetails?.originalFilename || 'resume.pdf');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      if (err instanceof ApiException) {
        alert(`Download failed: ${err.message}`);
      } else {
        alert('Failed to initiate document download.');
      }
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDelete = async (targetId?: string) => {
    const id = targetId || resumeId;
    if (!id || !token.trim()) return;

    if (!confirm('Are you sure you want to permanently delete this resume and all extracted data?')) {
      return;
    }

    setIsDeleting(true);
    try {
      await api.deleteResume(id, token.trim());
      if (id === resumeId) {
        resetUpload();
      }
      loadUserResumes();
    } catch (err) {
      if (err instanceof ApiException) {
        alert(`Deletion failed: ${err.message}`);
      } else {
        alert('Failed to delete resume.');
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const resetUpload = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }
    setFile(null);
    setStep('idle');
    setUploadProgress(0);
    setErrorMessage(null);
    setErrorDetails(null);
    setErrorCode(null);
    setResumeDetails(null);
    setResumeId(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const testStubEndpoint = async () => {
    setIsCallingStub(true);
    setStubStatus(null);
    try {
      await api.getResumes();
      setStubStatus('Unexpected: Endpoint responded with 200');
    } catch (err: unknown) {
      if (err instanceof ApiException) {
        setStubStatus(`Contract Verified: HTTP ${err.statusCode} (${err.errorName}) - "${err.message}"`);
      } else if (err instanceof Error) {
        setStubStatus(`Network Error: ${err.message}`);
      } else {
        setStubStatus(`Network Error: ${typeof err === 'string' ? err : 'Unknown'}`);
      }
    } finally {
      setIsCallingStub(false);
    }
  };

  const isUploading =
    step === 'requesting_url' ||
    step === 'uploading' ||
    step === 'confirming' ||
    step === 'processing';

  return (
    <div className="flex-1 flex flex-col items-center justify-start px-4 sm:px-6 lg:px-8 py-10 space-y-10">
      <div className="w-full max-w-4xl flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Cluster Overview
        </Link>
        <span className="text-xs px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
          Phase 2D • Resume Lifecycle & Ingestion
        </span>
      </div>

      <div className="w-full max-w-4xl space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Resume Ingestion & Lifecycle</h1>
          <p className="text-sm text-slate-400 mt-1">
            Secure presigned upload, OCR routing, parsing, ATS hazard scoring, and private storage lifecycle.
          </p>
        </div>

        {/* Authentication Token Bar */}
        <div className="glass-panel p-4 rounded-xl border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <Key className="h-4 w-4 text-blue-400" />
              <span>JWT Authentication Token</span>
              {token.trim() ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                  Configured
                </span>
              ) : (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                  Required
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowTokenInput(!showTokenInput)}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
            >
              {showTokenInput ? 'Hide Token Settings' : 'Configure Token'}
            </button>
          </div>

          {showTokenInput && (
            <div className="pt-2 border-t border-slate-800/80 space-y-2">
              <input
                type="password"
                placeholder="Paste Bearer token (JWT) generated via scripts/mint-dev-token.ts..."
                value={token}
                onChange={(e) => handleTokenChange(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <p className="text-[11px] text-slate-500">
                Generate in development: <code className="text-slate-400">npx tsx src/scripts/mintDevToken.ts demo@resumatch.ai</code> (inside backend)
              </p>
            </div>
          )}
        </div>

        {/* Main Ingestion & Lifecycle Area */}
        {step !== 'success' ? (
          <div className="glass-panel rounded-2xl p-8 border border-slate-800 space-y-6">
            {!file ? (
              /* Drag-and-drop Dropzone */
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all ${
                  dragActive
                    ? 'border-blue-500 bg-blue-500/10 scale-[1.01]'
                    : 'border-slate-700/80 hover:border-slate-600 bg-slate-900/40 hover:bg-slate-900/60'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      handleFileSelect(e.target.files[0]);
                    }
                  }}
                  className="hidden"
                />

                <div className="mx-auto w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-400 mb-4 border border-blue-500/20 shadow-inner">
                  <UploadCloud className="h-8 w-8" />
                </div>

                <h3 className="text-lg font-semibold text-white">
                  Drop your resume here, or <span className="text-blue-400">browse</span>
                </h3>
                <p className="text-xs text-slate-400 mt-2">
                  Supports PDF and DOCX up to 5 MiB. Uploads directly to private S3-compatible storage.
                </p>
              </div>
            ) : (
              /* Selected File & Progress Display */
              <div className="space-y-6 text-center">
                <div className="inline-flex items-center gap-3 p-3 bg-slate-900/80 rounded-xl border border-slate-800 max-w-md mx-auto text-left">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 border border-blue-500/20 shrink-0">
                    <FileText className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0 pr-2">
                    <p className="text-sm font-medium text-white truncate">{file.name}</p>
                    <p className="text-xs text-slate-400 font-mono">
                      {(file.size / (1024 * 1024)).toFixed(2)} MB • {file.name.split('.').pop()?.toUpperCase()}
                    </p>
                  </div>
                  {!isUploading && (
                    <button
                      type="button"
                      onClick={() => setFile(null)}
                      className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                      title="Remove file"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  )}
                </div>

                {/* Upload Progress & Stepper */}
                {isUploading && (
                  <div className="space-y-3 max-w-lg mx-auto text-left">
                    <div className="flex items-center justify-between text-xs text-slate-300">
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                        {step === 'requesting_url' && 'Requesting presigned upload URL...'}
                        {step === 'uploading' && `Uploading directly to storage (${uploadProgress}%)...`}
                        {step === 'confirming' && 'Verifying file signature & queuing parser...'}
                        {step === 'processing' && (
                          <span>
                            Worker processing document: <strong className="text-blue-400">{resumeDetails?.status || 'EXTRACTING'}</strong>...
                          </span>
                        )}
                      </span>
                      {step === 'uploading' && <span className="font-mono">{uploadProgress}%</span>}
                    </div>

                    <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden border border-slate-800">
                      <div
                        className="bg-blue-500 h-full transition-all duration-200 ease-out"
                        style={{
                          width:
                            step === 'requesting_url'
                              ? '15%'
                              : step === 'uploading'
                              ? `${Math.max(15, uploadProgress)}%`
                              : step === 'confirming'
                              ? '75%'
                              : '90%',
                        }}
                      />
                    </div>
                  </div>
                )}

                {!isUploading && (
                  <div className="flex justify-center gap-3">
                    <button
                      type="button"
                      onClick={handleUpload}
                      disabled={isUploading}
                      className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold shadow-lg shadow-blue-600/25 transition-all disabled:opacity-50"
                    >
                      Start Ingestion
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors"
                    >
                      Choose Different File
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Error Banner */}
            {errorMessage && (
              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs text-left max-w-lg mx-auto space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
                  <div className="flex-1">
                    <p className="font-semibold">
                      {errorCode ? `[${errorCode}] ` : ''}
                      {errorMessage}
                    </p>
                    {errorDetails && (
                      <pre className="mt-2 p-2 bg-slate-950/80 rounded border border-rose-500/20 overflow-x-auto text-[11px] font-mono text-rose-200">
                        {errorDetails}
                      </pre>
                    )}
                  </div>
                </div>
                <div className="pt-2 flex justify-end">
                  <button
                    onClick={resetUpload}
                    className="px-3 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-[11px] font-medium transition-colors"
                  >
                    Reset & Try Again
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Success Screen with Parsed Results (Phase 2D) */
          <div className="glass-panel border border-emerald-500/20 bg-emerald-500/5 rounded-2xl p-8 space-y-8">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-400 border border-emerald-500/20 shrink-0">
                  <ShieldCheck className="h-8 w-8" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">
                    {resumeDetails?.parsedResume?.candidateName || file?.name || 'Resume Parsed Successfully'}
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5 font-mono">
                    ID: {resumeDetails?.id} • Method: {resumeDetails?.extractionMethod || 'PARSED'} • {resumeDetails?.parsedResume?.pageCount || 1} Page(s)
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleDownload()}
                  disabled={isDownloading}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5 text-blue-400" />
                  {isDownloading ? 'Downloading...' : 'Download File'}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete()}
                  disabled={isDeleting}
                  className="px-4 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-xs font-semibold flex items-center gap-1.5 border border-rose-500/20 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                  {isDeleting ? 'Deleting...' : 'Delete'}
                </button>
                <button
                  type="button"
                  onClick={resetUpload}
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-all"
                >
                  Upload Another
                </button>
              </div>
            </div>

            {/* ATS Score & Overview Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* ATS Score */}
              <div className="glass-panel p-5 rounded-xl border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span>ATS Compliance Score</span>
                  <Award className="h-4 w-4 text-emerald-400" />
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-extrabold text-white">
                    {Math.round(resumeDetails?.parsedResume?.atsScore ?? 0)}
                  </span>
                  <span className="text-xs text-slate-500">/ 100</span>
                </div>
                <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-emerald-500 h-full rounded-full"
                    style={{ width: `${Math.min(100, Math.max(0, resumeDetails?.parsedResume?.atsScore ?? 0))}%` }}
                  />
                </div>
              </div>

              {/* Contact Info */}
              <div className="glass-panel p-5 rounded-xl border border-slate-800 space-y-2 text-xs">
                <span className="text-slate-400 font-medium">Contact Extracted</span>
                <div className="text-slate-300 space-y-1">
                  <p className="truncate">Email: {resumeDetails?.parsedResume?.contactInfo?.email || 'N/A'}</p>
                  <p className="truncate">Phone: {resumeDetails?.parsedResume?.contactInfo?.phone || 'N/A'}</p>
                  <p className="truncate">Location: {resumeDetails?.parsedResume?.contactInfo?.location || 'N/A'}</p>
                </div>
              </div>

              {/* Sections Breakdown */}
              <div className="glass-panel p-5 rounded-xl border border-slate-800 space-y-2 text-xs">
                <span className="text-slate-400 font-medium">Extracted Sections</span>
                <div className="flex flex-col gap-1 text-slate-300">
                  <div className="flex items-center gap-1.5">
                    <Briefcase className="h-3.5 w-3.5 text-blue-400" />
                    <span>{resumeDetails?.parsedResume?.experience?.length || 0} Work Experience Roles</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <GraduationCap className="h-3.5 w-3.5 text-purple-400" />
                    <span>{resumeDetails?.parsedResume?.education?.length || 0} Education Items</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Layers className="h-3.5 w-3.5 text-amber-400" />
                    <span>{resumeDetails?.parsedResume?.skills?.length || 0} Categorized Skills</span>
                  </div>
                </div>
              </div>
            </div>

            {/* ATS Hazards */}
            {resumeDetails?.parsedResume?.atsHazards && resumeDetails.parsedResume.atsHazards.length > 0 && (
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                  ATS Layout Findings & Hazards
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {resumeDetails.parsedResume.atsHazards.map((hazard, i) => (
                    <div
                      key={i}
                      className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] text-amber-400">{hazard.type}</span>
                        <span className="text-[10px] uppercase font-semibold text-slate-500">
                          {hazard.severity}
                        </span>
                      </div>
                      <p className="text-slate-300 text-[11px]">{hazard.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Categorized Skills */}
            {resumeDetails?.parsedResume?.skills && resumeDetails.parsedResume.skills.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Extracted Skills & Canonical Offsets
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {resumeDetails.parsedResume.skills.map((skill, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 rounded-md bg-slate-800/80 border border-slate-700 text-slate-200 text-xs font-medium"
                      title={`Category: ${skill.category} • Offsets: [${skill.startChar}, ${skill.endChar}]`}
                    >
                      {skill.name}
                      <span className="ml-1 text-[10px] text-slate-500 font-mono">
                        ({skill.category.slice(0, 4)})
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* User's Resumes Library (Phase 2D) */}
        {token.trim() && (
          <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-white">Your Ingested Resumes</h3>
                <p className="text-xs text-slate-400">
                  Manage private resume documents stored in object storage.
                </p>
              </div>
              <button
                onClick={loadUserResumes}
                disabled={isLoadingResumes}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                title="Refresh Resumes"
              >
                <RefreshCw className={`h-4 w-4 ${isLoadingResumes ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {myResumes.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">No resumes uploaded yet.</p>
            ) : (
              <div className="divide-y divide-slate-800/60 overflow-hidden rounded-xl border border-slate-800">
                {myResumes.map((res) => (
                  <div
                    key={res.id}
                    className="p-3.5 bg-slate-900/40 hover:bg-slate-900/80 flex items-center justify-between gap-4 transition-colors text-xs"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <FileText className="h-4 w-4 text-blue-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium text-slate-200 truncate">{res.originalFilename}</p>
                        <p className="text-[11px] text-slate-500 font-mono">
                          {new Date(res.createdAt).toLocaleDateString()} • {(res.sizeBytes / 1024).toFixed(1)} KB
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${
                          res.status === 'PARSED'
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : res.status === 'FAILED'
                            ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                            : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                        }`}
                      >
                        {res.status}
                      </span>

                      <button
                        onClick={() => handleDownload(res.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                        title="Download Document"
                      >
                        <Download className="h-4 w-4" />
                      </button>

                      <button
                        onClick={() => handleDelete(res.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                        title="Delete Resume"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Phase 1 Contract Verification Probe */}
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-white">Phase 1 Route Stub Contract Probe</h3>
              <p className="text-xs text-slate-400">
                Verify that unversioned legacy stubs return HTTP 501 Not Implemented
              </p>
            </div>
            <button
              onClick={testStubEndpoint}
              disabled={isCallingStub}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
            >
              {isCallingStub ? 'Calling /resumes...' : 'Test GET /resumes'}
            </button>
          </div>

          {stubStatus && (
            <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{stubStatus}</span>
            </div>
          )}
        </div>

        {/* Live Cluster Health Display */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-white">Dependency Readiness</h2>
          <HealthDashboard />
        </div>
      </div>
    </div>
  );
}
