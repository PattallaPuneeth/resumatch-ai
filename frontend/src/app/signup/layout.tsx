import type { Metadata } from 'next';

// Sent with the server HTML, so the tab shows the right title before the page's own code runs
export const metadata: Metadata = { title: 'Create Account | ResuMatch AI' };

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
