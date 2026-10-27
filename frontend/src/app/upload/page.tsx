import { redirect } from 'next/navigation';

/**
 * Legacy Phase 2D /upload route.
 * Redirects to /dashboard where the production authenticated ResumeUpload component is hosted.
 */
export default function UploadPage() {
  redirect('/dashboard');
}
