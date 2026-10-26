'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/authContext';
import { FileText, LayoutDashboard, User, LogOut, LogIn, UserPlus } from 'lucide-react';

export function Navbar() {
  const { user, isAuthenticated, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
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
            className="flex items-center gap-2.5 font-bold text-lg text-foreground tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md px-1"
          >
            <div className="w-8 h-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center font-bold text-base shadow-sm">
              R
            </div>
            <span>ResuMatch <span className="text-primary font-semibold">AI</span></span>
          </Link>

          {isAuthenticated && (
            <nav className="hidden sm:flex items-center gap-1 text-sm font-medium">
              <Link
                href="/dashboard"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  isActive('/dashboard')
                    ? 'bg-accent text-accent-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-slate-100'
                }`}
              >
                <LayoutDashboard className="h-4 w-4 text-primary" />
                Dashboard
              </Link>
              <Link
                href="/account"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
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

        <div className="flex items-center gap-3">
          {isAuthenticated ? (
            <div className="flex items-center gap-3">
              <span className="hidden md:inline-block text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-800 border border-slate-200">
                {user?.username}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="flex items-center gap-1.5 text-xs sm:text-sm font-medium px-3 py-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              >
                <LogOut className="h-4 w-4" />
                <span>Log out</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link
                href="/login"
                className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md text-foreground hover:bg-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <LogIn className="h-4 w-4" />
                Log in
              </Link>
              <Link
                href="/signup"
                className="flex items-center gap-1.5 text-sm font-medium px-3.5 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary-hover shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                <UserPlus className="h-4 w-4" />
                Sign up
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
