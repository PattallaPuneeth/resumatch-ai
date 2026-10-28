import type { Metadata } from 'next';

// Sent with the server HTML, so the tab shows the right title before the page's own code runs
export const metadata: Metadata = { title: 'Sign In | ResuMatch AI' };

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
