'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useBackendHealth() {
  return useQuery({
    queryKey: ['health', 'backend'],
    queryFn: () => api.getBackendHealth(),
    // The public status panel: every 30 s is live enough and spares a request per visitor every 5 s
    refetchInterval: 30000,
    retry: 1,
  });
}

export function useMLHealth() {
  return useQuery({
    queryKey: ['health', 'ml'],
    queryFn: () => api.getMLHealth(),
    refetchInterval: 30000,
    retry: 1,
  });
}
