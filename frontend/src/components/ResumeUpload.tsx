'use client';

import React, { useState, useRef } from 'react';
import { Upload, FileText, CheckCircle, AlertCircle, X, Loader2 } from 'lucide-react';
import { apiClient, ApiProblemError } from '@/lib/apiClient';
import { formatBytes } from '@/components/UsagePanel';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

interface ResumeUploadProps {
  onUploadSuccess?: (resumeId: string) => void;
  className?: string;
}

export function ResumeUpload({ onUploadSuccess, className }: ResumeUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'completing' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<ApiProblemError | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const validateFile = (file: File): string | null => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pdf' && ext !== 'docx') {
      return 'Only PDF (.pdf) and DOCX (.docx) documents are supported.';
    }
    if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
      if (!file.name.endsWith('.pdf') && !file.name.endsWith('.docx')) {
        return 'Unsupported file MIME type. Please provide a standard PDF or DOCX resume.';
      }
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return `File exceeds maximum allowed size of 5 MB (selected file is ${formatBytes(file.size)}).`;
    }
    if (file.size <= 0) {
      return 'The selected file is empty.';
    }
    return null;
  };

  const handleFileSelect = (file: File) => {
    setErrorMessage(null);
    setErrorDetails(null);
    setUploadStatus('idle');
    setUploadProgress(null);

    const validationError = validateFile(file);
    if (validationError) {
      setErrorMessage(validationError);
      setSelectedFile(null);
      return;
    }

    setSelectedFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleCancel = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
    setUploadStatus('idle');
    setUploadProgress(null);
    setErrorMessage('Upload cancelled by user.');
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setErrorMessage(null);
    setErrorDetails(null);
    setUploadStatus('uploading');
    setUploadProgress(0);

    try {
      // Step 1: Request presigned upload URL from backend
      const mimeType = selectedFile.type || (selectedFile.name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      const presigned = await apiClient.resumes.requestUploadUrl({
        filename: selectedFile.name,
        mimeType,
        sizeBytes: selectedFile.size,
      });

      // Step 2: Upload directly to MinIO/R2 object storage with progress tracking
      await apiClient.resumes.uploadToStorage(
        presigned.uploadUrl,
        selectedFile,
        presigned.headers,
        (percent) => {
          setUploadProgress(percent);
        },
        cancelRef
      );

      // Step 3: Complete upload and trigger document parsing queue
      setUploadStatus('completing');
      await apiClient.resumes.completeUpload(presigned.resumeId);

      setUploadStatus('success');
      setUploadProgress(100);
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      if (onUploadSuccess) {
        onUploadSuccess(presigned.resumeId);
      }
    } catch (err: unknown) {
      setUploadStatus('error');
      setUploadProgress(null);
      if (err instanceof ApiProblemError) {
        setErrorDetails(err);
        setErrorMessage(err.detail);
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('An unexpected error occurred during upload.');
      }
    }
  };

  const isUploading = uploadStatus === 'uploading' || uploadStatus === 'completing';

  return (
    <div className={`bg-card rounded-lg border border-border p-6 shadow-sm ${className || ''}`} data-testid="resume-upload">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-foreground">Upload Resume</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          PDF and DOCX formats supported. Maximum size 5 MB. Evaluated with exact character extraction and ATS compliance checks.
        </p>
      </div>

      {/* Drag & Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        data-testid="dropzone"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !isUploading) {
            fileInputRef.current?.click();
          }
        }}
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          isDragging
            ? 'border-primary bg-emerald-50/50'
            : isUploading
            ? 'border-slate-300 bg-slate-50 cursor-not-allowed opacity-80'
            : 'border-slate-300 hover:border-primary hover:bg-slate-50'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          data-testid="file-input"
          disabled={isUploading}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              handleFileSelect(e.target.files[0]);
            }
          }}
        />

        <div className="flex flex-col items-center justify-center gap-2">
          <div className="p-3 rounded-full bg-slate-100 text-primary">
            <Upload className="h-6 w-6 text-primary" />
          </div>
          <div>
            <span className="text-sm font-medium text-foreground">
              Click to select or drag and drop your resume
            </span>
            <p className="text-xs text-muted-foreground mt-0.5">PDF or DOCX (up to 5 MB)</p>
          </div>
        </div>
      </div>

      {/* Selected File Details */}
      {selectedFile && !isUploading && (
        <div className="mt-4 p-3 rounded-md bg-slate-50 border border-border flex items-center justify-between">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <FileText className="h-5 w-5 text-primary shrink-0" />
            <div className="truncate">
              <span className="text-xs font-semibold text-foreground truncate block">
                {selectedFile.name}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {formatBytes(selectedFile.size)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedFile(null)}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-slate-200 transition-colors"
              aria-label="Remove selected file"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleUpload}
              data-testid="upload-button"
              className="text-xs font-semibold px-4 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary-hover transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Start Upload
            </button>
          </div>
        </div>
      )}

      {/* Progress & Uploading State */}
      {isUploading && (
        <div className="mt-4 p-4 rounded-md bg-slate-50 border border-border space-y-3" data-testid="upload-progress-container">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="font-semibold text-foreground">
                {uploadStatus === 'uploading' ? `Uploading ${uploadProgress ?? 0}%` : 'Finalizing & queuing parse...'}
              </span>
            </div>
            {uploadStatus === 'uploading' && (
              <button
                type="button"
                onClick={handleCancel}
                data-testid="cancel-upload-button"
                className="text-xs text-destructive hover:underline font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive rounded"
              >
                Cancel
              </button>
            )}
          </div>

          <div
            role="progressbar"
            aria-valuenow={uploadProgress ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Upload progress"
            className="w-full h-2 rounded-full bg-slate-200 overflow-hidden"
          >
            <div
              className="h-full bg-primary transition-all duration-150"
              style={{ width: `${uploadProgress ?? 5}%` }}
            />
          </div>
        </div>
      )}

      {/* Success Notification */}
      {uploadStatus === 'success' && (
        <div
          role="status"
          data-testid="upload-success-banner"
          className="mt-4 p-3 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-900 flex items-start gap-2.5 text-xs"
        >
          <CheckCircle className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold block">Resume successfully uploaded</span>
            <span>Your document has been sent to the worker queue. Processing starts automatically.</span>
          </div>
        </div>
      )}

      {/* Error Notification */}
      {errorMessage && (
        <div
          role="alert"
          data-testid="upload-error-banner"
          className="mt-4 p-3 rounded-md bg-red-50 border border-red-200 text-red-900 flex items-start gap-2.5 text-xs"
        >
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div className="space-y-1">
            <span className="font-semibold block">
              {errorDetails?.meter === 'resume_storage_bytes' ? 'Storage Quota Exceeded (HTTP 429)' : 'Upload Failed'}
            </span>
            <p className="text-xs">{errorMessage}</p>
            {errorDetails?.meter === 'resume_storage_bytes' && errorDetails.limit && (
              <p className="text-[11px] text-red-800">
                Current storage: {formatBytes(errorDetails.used ?? 0)} / {formatBytes(errorDetails.limit)}. You can delete older resumes on your dashboard to free up space.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
