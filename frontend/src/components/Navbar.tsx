'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useAuth } from '@/lib/authContext';
import { LayoutDashboard, User, LogOut, LogIn, UserPlus, Sparkles, Menu, X } from 'lucide-react';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { href: '/analyze', label: 'Analyze', Icon: Sparkles },
  { href: '/account', label: 'Account', Icon: User },
];

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2';

export function Navbar() {
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    setMobileMenuOpen(false);
    await logout();
    router.push('/login');
  };

  const isActive = (path: string) => pathname === path;

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-white/90 backdrop-blur-md">
      <div className="container mx-auto flex h-16 items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Link
            href="/"
            onClick={() => setMobileMenuOpen(false)}
            className={`flex items-center gap-2 rounded-md px-1 min-h-[44px] ${focusRing}`}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-white">
              R
            </span>
            <span className="font-display text-lg font-semibold tracking-tight text-foreground">
              ResuMatch
              <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-highlight-strong align-baseline" aria-hidden="true" />
            </span>
          </Link>

          {isAuthenticated && (
            <nav className="hidden sm:flex items-center gap-1 text-sm" aria-label="Main Navigation">
              {NAV_LINKS.map(({ href, label, Icon }) => (
                <Link
                  key={href}
                  href={href}
                  aria-current={isActive(href) ? 'page' : undefined}
                  className={`relative flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-md transition-colors ${focusRing} ${
                    isActive(href) ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                  {isActive(href) && (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute inset-x-3 -bottom-[13px] h-0.5 rounded-full bg-primary"
                      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                      aria-hidden="true"
                    />
                  )}
                </Link>
              ))}
            </nav>
          )}
        </div>

        {/* Desktop actions */}
        <div className="hidden sm:flex items-center gap-2">
          {/* While the session check runs, show nothing rather than a misleading "Log in" */}
          {isLoading ? (
            <span aria-hidden="true" className="inline-block h-11 w-40" />
          ) : isAuthenticated ? (
            <>
              <span className="hidden md:inline-block text-xs font-medium px-2.5 py-1 rounded-full bg-secondary text-foreground border border-border">
                {user?.username}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className={`flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors min-h-[44px] ${focusRing}`}
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>Log out</span>
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className={`flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-md text-foreground hover:bg-secondary transition-colors min-h-[44px] ${focusRing}`}
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                Log in
              </Link>
              <Link
                href="/signup"
                className={`flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-md bg-primary text-white hover:bg-primary-hover transition-colors min-h-[44px] ${focusRing}`}
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                Sign up
              </Link>
            </>
          )}
        </div>

        {/* Mobile menu button */}
        <div className="flex sm:hidden items-center">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-menu"
            aria-label="Toggle navigation menu"
            className={`p-2.5 rounded-lg text-foreground hover:bg-secondary min-h-[44px] min-w-[44px] flex items-center justify-center ${focusRing}`}
          >
            {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div id="mobile-menu" className="sm:hidden border-b border-border bg-white px-4 pt-2 pb-6 space-y-3 mobile-menu-enter shadow-sm">
          {/* While the session check runs, show nothing rather than a misleading "Log in" */}
          {isLoading ? (
            <span aria-hidden="true" className="inline-block h-11 w-40" />
          ) : isAuthenticated ? (
            <nav className="flex flex-col space-y-1" aria-label="Mobile Navigation">
              <div className="px-3 py-2 text-xs text-muted-foreground bg-secondary rounded-md mb-2">
                Signed in as <span className="font-semibold text-foreground">{user?.username}</span>
              </div>
              {NAV_LINKS.map(({ href, label, Icon }) => (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileMenuOpen(false)}
                  aria-current={isActive(href) ? 'page' : undefined}
                  className={`flex items-center gap-2 px-3 py-3 rounded-lg text-sm min-h-[44px] ${
                    isActive(href) ? 'bg-accent text-accent-foreground font-semibold' : 'text-foreground hover:bg-secondary'
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  {label}
                </Link>
              ))}
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-3 rounded-lg text-sm font-medium text-destructive hover:bg-red-50 text-left min-h-[44px]"
              >
                <LogOut className="h-5 w-5" aria-hidden="true" />
                Log out
              </button>
            </nav>
          ) : (
            <div className="flex flex-col space-y-2 pt-2">
              <Link
                href="/login"
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold border border-border text-foreground hover:bg-secondary min-h-[44px]"
              >
                <LogIn className="h-5 w-5" aria-hidden="true" />
                Log in
              </Link>
              <Link
                href="/signup"
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-primary text-white hover:bg-primary-hover min-h-[44px]"
              >
                <UserPlus className="h-5 w-5" aria-hidden="true" />
                Sign up
              </Link>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
