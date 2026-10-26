'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { apiClient, UserSummary, ApiProblemError } from './apiClient';

interface AuthContextValue {
  user: UserSummary | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (credentials: { username: string; password: string }) => Promise<void>;
  register: (data: { username: string; password: string }) => Promise<{ recoveryCodes?: string[] }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const response = await apiClient.auth.getMe();
      setUser(response.user);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = async (credentials: { username: string; password: string }) => {
    const res = await apiClient.auth.login(credentials);
    setUser(res.user);
  };

  const register = async (data: { username: string; password: string }) => {
    const res = await apiClient.auth.register(data);
    setUser(res.user);
    return { recoveryCodes: res.recoveryCodes };
  };

  const logout = async () => {
    try {
      await apiClient.auth.logout();
    } catch {
      // Clear client state even if network call errors
    } finally {
      setUser(null);
    }
  };

  const value: AuthContextValue = {
    user,
    isLoading,
    isAuthenticated: !!user,
    login,
    register,
    logout,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
