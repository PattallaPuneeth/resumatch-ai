import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResumeUpload } from '../ResumeUpload';
import { apiClient, ApiProblemError } from '@/lib/apiClient';

describe('ResumeUpload Component (src/components/ResumeUpload.tsx)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Client-Side Pre-Checks', () => {
    it('rejects files larger than 5 MB with a clear error message before calling API', async () => {
      const requestSpy = vi.spyOn(apiClient.resumes, 'requestUploadUrl');
      render(<ResumeUpload />);

      const fileInput = screen.getByTestId('file-input');
      const largeFile = new File(['x'.repeat(100)], 'huge_resume.pdf', { type: 'application/pdf' });
      Object.defineProperty(largeFile, 'size', { value: 6 * 1024 * 1024 }); // 6 MB

      fireEvent.change(fileInput, { target: { files: [largeFile] } });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined();
      });

      expect(screen.getByText(/File exceeds maximum allowed size of 5 MB/)).toBeDefined();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('rejects unsupported file formats (e.g. .exe or .txt) before calling API', async () => {
      const requestSpy = vi.spyOn(apiClient.resumes, 'requestUploadUrl');
      render(<ResumeUpload />);

      const fileInput = screen.getByTestId('file-input');
      const invalidFile = new File(['echo evil'], 'malicious.exe', { type: 'application/x-msdownload' });

      fireEvent.change(fileInput, { target: { files: [invalidFile] } });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined();
      });

      expect(screen.getByText(/Only PDF \(\.pdf\) and DOCX \(\.docx\) documents are supported/)).toBeDefined();
      expect(requestSpy).not.toHaveBeenCalled();
    });
  });

  describe('Upload Flow and Progress', () => {
    it('executes 3-step upload: requestUrl -> storage PUT -> completeUpload', async () => {
      const requestSpy = vi.spyOn(apiClient.resumes, 'requestUploadUrl').mockResolvedValue({
        resumeId: 'test-resume-1',
        uploadUrl: 'http://localhost:9000/resumes/test.pdf',
        headers: { 'Content-Type': 'application/pdf' },
        expiresIn: 300,
        storageKey: 'resumes/u1/test-resume-1.pdf',
      });

      const storageSpy = vi.spyOn(apiClient.resumes, 'uploadToStorage').mockImplementation(
        async (_url, _file, _headers, onProgress) => {
          if (onProgress) onProgress(50);
          if (onProgress) onProgress(100);
        }
      );

      const completeSpy = vi.spyOn(apiClient.resumes, 'completeUpload').mockResolvedValue({
        resumeId: 'test-resume-1',
        status: 'PROCESSING',
        message: 'Resume accepted for processing',
      });

      const onUploadSuccess = vi.fn();
      render(<ResumeUpload onUploadSuccess={onUploadSuccess} />);

      const fileInput = screen.getByTestId('file-input');
      const validFile = new File(['%PDF-1.4 test resume'], 'my_resume.pdf', { type: 'application/pdf' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      const uploadButton = await screen.findByTestId('upload-button');
      fireEvent.click(uploadButton);

      await waitFor(() => {
        expect(screen.getByTestId('upload-success-banner')).toBeDefined();
      });

      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(storageSpy).toHaveBeenCalledTimes(1);
      expect(completeSpy).toHaveBeenCalledWith('test-resume-1');
      expect(onUploadSuccess).toHaveBeenCalledWith('test-resume-1');
    });

    it('displays 429 storage quota limit banner when API rejects due to storage quota', async () => {
      const quotaError = new ApiProblemError(429, {
        type: 'https://api.resumatch.ai/errors/usage-limit-exceeded',
        title: 'Usage Limit Exceeded',
        status: 429,
        detail: 'Usage limit reached for meter "resume_storage_bytes". Current usage: 5242880/5242880.',
        meter: 'resume_storage_bytes',
        used: 5242880,
        limit: 5242880,
      });

      vi.spyOn(apiClient.resumes, 'requestUploadUrl').mockRejectedValue(quotaError);

      render(<ResumeUpload />);

      const fileInput = screen.getByTestId('file-input');
      const validFile = new File(['%PDF-1.4 test'], 'resume.pdf', { type: 'application/pdf' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      const uploadButton = await screen.findByTestId('upload-button');
      fireEvent.click(uploadButton);

      await waitFor(() => {
        expect(screen.getByTestId('upload-error-banner')).toBeDefined();
      });

      expect(screen.getByText('Storage Quota Exceeded (HTTP 429)')).toBeDefined();
      expect(screen.getByText(/Current usage: 5242880\/5242880/)).toBeDefined();
    });
  });

  describe('Cancel Support', () => {
    it('aborts upload and informs user when cancel button is clicked', async () => {
      vi.spyOn(apiClient.resumes, 'requestUploadUrl').mockResolvedValue({
        resumeId: 'cancel-res-1',
        uploadUrl: 'http://localhost:9000/resumes/cancel.pdf',
        headers: {},
        expiresIn: 300,
        storageKey: 'resumes/u1/cancel.pdf',
      });

      let cancelCallbackTriggered = false;
      vi.spyOn(apiClient.resumes, 'uploadToStorage').mockImplementation(
        (_url, _file, _headers, _onProgress, onCancelRef) => {
          return new Promise((_resolve, reject) => {
            if (onCancelRef) {
              onCancelRef.current = () => {
                cancelCallbackTriggered = true;
                reject(new ApiProblemError(499, { title: 'Upload Cancelled', detail: 'Upload was cancelled by the user.' }));
              };
            }
          });
        }
      );

      render(<ResumeUpload />);

      const fileInput = screen.getByTestId('file-input');
      const validFile = new File(['%PDF-1.4 cancel test'], 'cancel_resume.pdf', { type: 'application/pdf' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      const uploadButton = await screen.findByTestId('upload-button');
      fireEvent.click(uploadButton);

      const cancelButton = await screen.findByTestId('cancel-upload-button');
      fireEvent.click(cancelButton);

      await waitFor(() => {
        expect(screen.getByTestId('upload-error-banner')).toBeDefined();
      });

      expect(cancelCallbackTriggered).toBe(true);
      expect(screen.getByText(/Upload was cancelled by the user/)).toBeDefined();
    });
  });
});
