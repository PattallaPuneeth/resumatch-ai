import type { Metadata } from 'next';

// Sent with the server HTML, so the tab shows the right title before the page's own code runs
export const metadata: Metadata = { title: 'Account Settings | ResuMatch AI' };

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return children;
}
