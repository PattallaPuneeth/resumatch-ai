import type { Metadata } from 'next';

// Sent with the server HTML, so the tab shows the right title before the page's own code runs
export const metadata: Metadata = { title: 'Analyze & Match | ResuMatch AI' };

export default function AnalyzeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
