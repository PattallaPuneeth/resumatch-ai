import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UsagePanel, formatBytes } from '../UsagePanel';
import { apiClient, UserUsageResponse } from '@/lib/apiClient';

describe('UsagePanel Component (src/components/UsagePanel.tsx)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
  });

  const renderWithClient = (ui: React.ReactElement) => {
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  };

  describe('formatBytes helper', () => {
    it('formats 0 bytes as 0 B', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('formats kilobytes correctly', () => {
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(2560)).toBe('2.5 KB');
    });

    it('formats megabytes correctly', () => {
      expect(formatBytes(1048576)).toBe('1 MB');
      expect(formatBytes(5242880)).toBe('5 MB');
    });

    it('formats gigabytes correctly', () => {
      expect(formatBytes(1073741824)).toBe('1 GB');
    });
  });

  describe('Unlimited Plan State', () => {
    it('renders all three meters and shows NO alert banners when plan is unlimited', async () => {
      const unlimitedUsage: UserUsageResponse = {
        plan: 'unlimited',
        planName: 'Unlimited Plan',
        period: '2026-10',
        periodStart: '2026-10-01T00:00:00.000Z',
        resetAt: '2026-11-01T00:00:00.000Z',
        meters: {
          analyses: {
            used: 12,
            limit: null,
            unlimited: true,
            percent: null,
            activeThreshold: null,
            crossedThresholds: [],
            blocked: false,
            periodStart: '2026-10-01T00:00:00.000Z',
            resetAt: '2026-11-01T00:00:00.000Z',
          },
          job_suggestions: {
            used: 3,
            limit: null,
            unlimited: true,
            percent: null,
            activeThreshold: null,
            crossedThresholds: [],
            blocked: false,
            periodStart: '2026-10-01T00:00:00.000Z',
            resetAt: '2026-11-01T00:00:00.000Z',
          },
          resume_storage_bytes: {
            used: 2450000,
            limit: null,
            unlimited: true,
            percent: null,
            activeThreshold: null,
            crossedThresholds: [],
            blocked: false,
            periodStart: null,
            resetAt: null,
          },
        },
      };

      vi.spyOn(apiClient.usage, 'get').mockResolvedValue(unlimitedUsage);

      renderWithClient(<UsagePanel />);

      await waitFor(() => {
        expect(screen.getByTestId('usage-panel')).toBeDefined();
      });

      // Verify all 3 meters are rendered
      expect(screen.getByTestId('meter-analyses')).toBeDefined();
      expect(screen.getByTestId('meter-job_suggestions')).toBeDefined();
      expect(screen.getByTestId('meter-resume_storage_bytes')).toBeDefined();

      // Verify "Unlimited" labels
      const unlimitedBadges = screen.getAllByText('Unlimited');
      expect(unlimitedBadges.length).toBeGreaterThanOrEqual(3);

      // Verify ZERO alert banners exist
      expect(screen.queryByTestId(/alert-50-/)).toBeNull();
      expect(screen.queryByTestId(/alert-70-/)).toBeNull();
      expect(screen.queryByTestId(/alert-90-/)).toBeNull();
      expect(screen.queryByTestId(/alert-100-/)).toBeNull();
    });
  });

  describe('Threshold Alert Banners (50%, 70%, 90%, 100%)', () => {
    const makeMeterState = (
      used: number,
      limit: number,
      activeThreshold: 50 | 70 | 90 | 100 | null,
      blocked: boolean
    ) => ({
      used,
      limit,
      unlimited: false,
      percent: Math.floor((used * 100) / limit),
      activeThreshold,
      crossedThresholds: activeThreshold ? [activeThreshold] : [],
      blocked,
      periodStart: '2026-10-01T00:00:00.000Z',
      resetAt: '2026-11-01T00:00:00.000Z',
    });

    it('renders 50% quota banner when activeThreshold is 50', async () => {
      const usage50: UserUsageResponse = {
        plan: 'demo',
        planName: 'Demo Plan',
        period: '2026-10',
        periodStart: '2026-10-01T00:00:00.000Z',
        resetAt: '2026-11-01T00:00:00.000Z',
        meters: {
          analyses: makeMeterState(5, 10, 50, false),
          job_suggestions: makeMeterState(1, 5, null, false),
          resume_storage_bytes: makeMeterState(1000, 5000000, null, false),
        },
      };

      vi.spyOn(apiClient.usage, 'get').mockResolvedValue(usage50);
      renderWithClient(<UsagePanel />);

      await waitFor(() => {
        expect(screen.getByTestId('alert-50-analyses')).toBeDefined();
      });

      expect(screen.getByText('50% Quota Update')).toBeDefined();
      expect(screen.getByText('You have utilized half of your current allocation.')).toBeDefined();
    });

    it('renders 70% quota banner when activeThreshold is 70', async () => {
      const usage70: UserUsageResponse = {
        plan: 'demo',
        planName: 'Demo Plan',
        period: '2026-10',
        periodStart: '2026-10-01T00:00:00.000Z',
        resetAt: '2026-11-01T00:00:00.000Z',
        meters: {
          analyses: makeMeterState(7, 10, 70, false),
          job_suggestions: makeMeterState(1, 5, null, false),
          resume_storage_bytes: makeMeterState(1000, 5000000, null, false),
        },
      };

      vi.spyOn(apiClient.usage, 'get').mockResolvedValue(usage70);
      renderWithClient(<UsagePanel />);

      await waitFor(() => {
        expect(screen.getByTestId('alert-70-analyses')).toBeDefined();
      });

      expect(screen.getByText('70% Quota Notice')).toBeDefined();
      expect(screen.getByText('You have crossed 70% of your usage limit for this period.')).toBeDefined();
    });

    it('renders 90% quota banner when activeThreshold is 90', async () => {
      const usage90: UserUsageResponse = {
        plan: 'demo',
        planName: 'Demo Plan',
        period: '2026-10',
        periodStart: '2026-10-01T00:00:00.000Z',
        resetAt: '2026-11-01T00:00:00.000Z',
        meters: {
          analyses: makeMeterState(9, 10, 90, false),
          job_suggestions: makeMeterState(1, 5, null, false),
          resume_storage_bytes: makeMeterState(1000, 5000000, null, false),
        },
      };

      vi.spyOn(apiClient.usage, 'get').mockResolvedValue(usage90);
      renderWithClient(<UsagePanel />);

      await waitFor(() => {
        expect(screen.getByTestId('alert-90-analyses')).toBeDefined();
      });

      expect(screen.getByText('90% Quota Warning')).toBeDefined();
      expect(screen.getByText('You have used 90% or more of your allocation. Approaching limit.')).toBeDefined();
    });

    it('renders 100% blocked alert banner when activeThreshold is 100 and blocked is true', async () => {
      const usage100: UserUsageResponse = {
        plan: 'demo',
        planName: 'Demo Plan',
        period: '2026-10',
        periodStart: '2026-10-01T00:00:00.000Z',
        resetAt: '2026-11-01T00:00:00.000Z',
        meters: {
          analyses: makeMeterState(10, 10, 100, true),
          job_suggestions: makeMeterState(5, 5, 100, true),
          resume_storage_bytes: makeMeterState(5242880, 5242880, 100, true),
        },
      };

      vi.spyOn(apiClient.usage, 'get').mockResolvedValue(usage100);
      renderWithClient(<UsagePanel />);

      await waitFor(() => {
        expect(screen.getByTestId('alert-100-analyses')).toBeDefined();
        expect(screen.getByTestId('alert-100-job_suggestions')).toBeDefined();
        expect(screen.getByTestId('alert-100-resume_storage_bytes')).toBeDefined();
      });

      const blockTitles = screen.getAllByText('100% Limit Reached');
      expect(blockTitles).toHaveLength(3);
    });
  });
});
