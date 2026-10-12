'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useBackendHealth() {
  return useQuery({
    queryKey: ['health', 'backend'],
    queryFn: () => api.getBackendHealth(),
    refetchInterval: 5000,
    retry: 1,
  });
}

export function useMLHealth() {
  return useQuery({
    queryKey: ['health', 'ml'],
    queryFn: () => api.getMLHealth(),
    refetchInterval: 5000,
    retry: 1,
  });
}
