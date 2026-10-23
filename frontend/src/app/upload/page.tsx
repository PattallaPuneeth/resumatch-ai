'use client';

import { useState, useRef, useEffect } from 'react';
import {
  UploadCloud,
  FileText,
  AlertCircle,
  Info,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  X,
  Key,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { HealthDashboard } from '@/components/HealthDashboard';
import { api, ApiException, UploadUrlResponse, CompleteUploadResponse } from '@/lib/api';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB per specification

const ACCEPTED_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

type UploadStep = 'idle' | 'requesting_url' | 'uploading' | 'confirming' | 'success' | 'error';

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
  const [successResult, setSuccessResult] = useState<CompleteUploadResponse | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(null);

  // Contract probe state
  const [stubStatus, setStubStatus] = useState<string | null>(null);
  const [isCallingStub, setIsCallingStub] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setSuccessResult(null);

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

  const handleUpload = async () => {
    if (!file) return;

    if (!token.trim()) {
      setShowTokenInput(true);
      setErrorMessage('Authentication token is required. Please provide a JWT Bearer token.');
      return;
    }

    setErrorMessage(null);
    setErrorDetails(null);
    setUploadProgress(0);

    // Map MIME type
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
      const completeResponse: CompleteUploadResponse = await api.completeUpload(
        urlResponse.resumeId,
        token.trim()
      );

      setSuccessResult(completeResponse);
      setStep('success');
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

  const resetUpload = () => {
    setFile(null);
    setStep('idle');
    setUploadProgress(0);
    setErrorMessage(null);
    setErrorDetails(null);
    setSuccessResult(null);
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

  const isUploading = step === 'requesting_url' || step === 'uploading' || step === 'confirming';

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
          Phase 2B • Presigned S3 Upload
        </span>
      </div>

      <div className="w-full max-w-4xl space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Resume Ingestion</h1>
          <p className="text-sm text-slate-400 mt-1">
            Secure presigned upload to private storage, file magic signature verification, and BullMQ queue intake.
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
              className="text-xs text-blue-400 hover:text-blue-300 underline"
            >
              {showTokenInput ? 'Hide Token Field' : token ? 'Edit Token' : 'Enter Token'}
            </button>
          </div>

          {showTokenInput && (
            <div className="space-y-2 pt-2 border-t border-slate-800/80">
              <p className="text-xs text-slate-400">
                Phase 2B endpoints require a Bearer token. Enter a valid JWT token signed by Fastify.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                  value={token}
                  onChange={(e) => handleTokenChange(e.target.value)}
                  className="flex-1 px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
                {token && (
                  <button
                    type="button"
                    onClick={() => handleTokenChange('')}
                    className="px-3 py-2 text-xs bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Upload Card / Dropzone */}
        {step !== 'success' ? (
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            className={`glass-panel border-2 ${
              dragActive ? 'border-blue-500 bg-blue-500/5' : 'border-dashed border-slate-800 hover:border-slate-700'
            } transition-all rounded-2xl p-8 sm:p-12 text-center space-y-6`}
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
              id="resume-file-input"
              disabled={isUploading}
            />

            {!file ? (
              <>
                <div className="mx-auto w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-400 border border-blue-500/20">
                  <UploadCloud className="h-8 w-8" />
                </div>

                <div className="space-y-1">
                  <h3 className="text-lg font-semibold text-white">Drop your resume here (PDF, DOCX)</h3>
                  <p className="text-xs text-slate-400">
                    Maximum file size: 5 MB • Documents are directly uploaded to private storage
                  </p>
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold shadow-lg shadow-blue-600/25 transition-all"
                  >
                    Select File
                  </button>
                </div>
              </>
            ) : (
              <div className="space-y-6">
                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between max-w-lg mx-auto">
                  <div className="flex items-center gap-3 text-left">
                    <div className="p-2.5 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
                      <FileText className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white truncate max-w-[280px]">{file.name}</p>
                      <p className="text-xs text-slate-400">
                        {(file.size / 1024).toFixed(1)} KB • {file.name.endsWith('.pdf') ? 'PDF' : 'DOCX'}
                      </p>
                    </div>
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
                              : '100%',
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
                      Start Upload
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
                    <p className="font-semibold">{errorMessage}</p>
                    {errorDetails && (
                      <pre className="mt-2 p-2 bg-slate-950/80 rounded border border-rose-500/20 overflow-x-auto text-[11px] font-mono text-rose-200">
                        {errorDetails}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Success Screen */
          <div className="glass-panel border border-emerald-500/20 bg-emerald-500/5 rounded-2xl p-10 text-center space-y-6">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-400 border border-emerald-500/20">
              <ShieldCheck className="h-8 w-8" />
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold text-white">Resume Accepted for Processing</h3>
              <p className="text-sm text-slate-300">
                File signature verified and PARSE_DOCUMENT job successfully queued.
              </p>
            </div>

            <div className="max-w-md mx-auto p-4 rounded-xl bg-slate-900 border border-slate-800 text-left space-y-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-slate-500">Resume ID:</span>
                <span className="text-purple-400">{successResult?.resumeId || resumeId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Status:</span>
                <span className="text-emerald-400 font-semibold">{successResult?.status || 'UPLOADED'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">File:</span>
                <span className="text-slate-300">{file?.name}</span>
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={resetUpload}
                className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all"
              >
                Upload Another Resume
              </button>
            </div>
          </div>
        )}

        {/* Phase 1 Contract Verification Probe */}
        <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-white">Phase 2D Route Stub Contract Probe</h3>
              <p className="text-xs text-slate-400">Verify that legacy / unauthenticated route stubs return HTTP 501 Not Implemented</p>
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
