'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/authContext';
import { LayoutDashboard, User, LogOut, LogIn, UserPlus, Sparkles, Menu, X } from 'lucide-react';

export function Navbar() {
  const { user, isAuthenticated, logout } = useAuth();
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
    <header className="sticky top-0 z-40 w-full border-b border-border bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="container mx-auto flex h-16 items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            onClick={() => setMobileMenuOpen(false)}
            className="flex items-center gap-2.5 font-bold text-lg text-foreground tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md px-1 min-h-[44px] min-w-[44px]"
          >
            <div className="w-8 h-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center font-bold text-base shadow-sm">
              R
            </div>
            <span>ResuMatch <span className="text-primary font-semibold">AI</span></span>
          </Link>

          {isAuthenticated && (
            <nav className="hidden sm:flex items-center gap-1 text-sm font-medium" aria-label="Main Navigation">
              <Link
                href="/dashboard"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary min-h-[44px] ${
                  isActive('/dashboard')
                    ? 'bg-accent text-accent-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-slate-100'
                }`}
              >
                <LayoutDashboard className="h-4 w-4 text-primary" />
                Dashboard
              </Link>
              <Link
                href="/analyze"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary min-h-[44px] ${
                  isActive('/analyze')
                    ? 'bg-accent text-accent-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-slate-100'
                }`}
              >
                <Sparkles className="h-4 w-4 text-primary" />
                Analyze
              </Link>
              <Link
                href="/account"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary min-h-[44px] ${
                  isActive('/account')
                    ? 'bg-accent text-accent-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-slate-100'
                }`}
              >
                <User className="h-4 w-4 text-primary" />
                Account
              </Link>
            </nav>
          )}
        </div>

        {/* Desktop Actions */}
        <div className="hidden sm:flex items-center gap-3">
          {isAuthenticated ? (
            <div className="flex items-center gap-3">
              <span className="hidden md:inline-block text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-800 border border-slate-200">
                {user?.username}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="flex items-center gap-1.5 text-xs sm:text-sm font-medium px-3 py-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive min-h-[44px]"
              >
                <LogOut className="h-4 w-4" />
                <span>Log out</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link
                href="/login"
                className="flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-md text-foreground hover:bg-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary min-h-[44px]"
              >
                <LogIn className="h-4 w-4" />
                Log in
              </Link>
              <Link
                href="/signup"
                className="flex items-center gap-1.5 text-sm font-medium px-3.5 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary-hover shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 min-h-[44px]"
              >
                <UserPlus className="h-4 w-4" />
                Sign up
              </Link>
            </div>
          )}
        </div>

        {/* Mobile Menu Button */}
        <div className="flex sm:hidden items-center">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-menu"
            aria-label="Toggle navigation menu"
            className="p-2.5 rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {/* Accessible Mobile Menu Dropdown */}
      {mobileMenuOpen && (
        <div
          id="mobile-menu"
          className="sm:hidden border-b border-border bg-white px-4 pt-2 pb-6 space-y-3 mobile-menu-enter shadow-lg"
        >
          {isAuthenticated ? (
            <nav className="flex flex-col space-y-1" aria-label="Mobile Navigation">
              <div className="px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-50 rounded-md mb-2">
                Signed in as <span className="font-bold text-slate-900">{user?.username}</span>
              </div>
              <Link
                href="/dashboard"
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-2 px-3 py-3 rounded-lg text-sm font-medium min-h-[44px] ${
                  isActive('/dashboard') ? 'bg-accent text-accent-foreground font-semibold' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <LayoutDashboard className="h-5 w-5 text-primary" />
                Dashboard
              </Link>
              <Link
                href="/analyze"
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-2 px-3 py-3 rounded-lg text-sm font-medium min-h-[44px] ${
                  isActive('/analyze') ? 'bg-accent text-accent-foreground font-semibold' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <Sparkles className="h-5 w-5 text-primary" />
                Analyze
              </Link>
              <Link
                href="/account"
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-2 px-3 py-3 rounded-lg text-sm font-medium min-h-[44px] ${
                  isActive('/account') ? 'bg-accent text-accent-foreground font-semibold' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <User className="h-5 w-5 text-primary" />
                Account
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-3 rounded-lg text-sm font-medium text-destructive hover:bg-red-50 text-left min-h-[44px]"
              >
                <LogOut className="h-5 w-5" />
                Log out
              </button>
            </nav>
          ) : (
            <div className="flex flex-col space-y-2 pt-2">
              <Link
                href="/login"
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold border border-slate-300 text-slate-800 hover:bg-slate-50 min-h-[44px]"
              >
                <LogIn className="h-5 w-5" />
                Log in
              </Link>
              <Link
                href="/signup"
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary-hover shadow-sm min-h-[44px]"
              >
                <UserPlus className="h-5 w-5" />
                Sign up
              </Link>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
