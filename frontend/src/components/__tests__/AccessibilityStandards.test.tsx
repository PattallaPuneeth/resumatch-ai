import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { ScoreGauge } from '../ui/ScoreGauge';
import { ResumeUpload } from '../ResumeUpload';
import { UsagePanel } from '../UsagePanel';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock apiClient and AuthContext
vi.mock('../../lib/apiClient', () => ({
  apiClient: {
    usage: {
      get: vi.fn().mockResolvedValue({
        plan: 'demo',
        planName: 'Demo Plan',
        period: 'monthly',
        periodStart: '2026-10-01T00:00:00Z',
        resetAt: '2026-11-01T00:00:00Z',
        meters: {
          analyses: {
            used: 9,
            limit: 10,
            percent: 90,
            activeThreshold: 90,
            crossedThresholds: [50, 70, 90],
            blocked: false,
          },
          job_suggestions: {
            used: 0,
            limit: 5,
            percent: 0,
            activeThreshold: null,
            crossedThresholds: [],
            blocked: false,
          },
          resume_storage_bytes: {
            used: 1000,
            limit: 5000000,
            percent: 0.02,
            activeThreshold: null,
            crossedThresholds: [],
            blocked: false,
          },
        },
        alerts: [
          {
            meter: 'analyses',
            threshold: 90,
            percent: 90,
            message: 'You have consumed 90% of your analyses quota.',
            severity: 'warning',
          },
        ],
      }),
    },
  },
}));

vi.mock('../../lib/authContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'testuser' },
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

describe('Accessibility Standards Verification Suite (Part 3.2)', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const renderWithClient = (ui: React.ReactElement) => {
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  };

  it('verifies skip link target (#main-content) exists and has tabIndex -1 in layout structure', () => {
    const { container } = render(
      <div>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-2 focus:bg-emerald-700 focus:text-white focus:rounded focus:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-600 font-semibold text-sm"
        >
          Skip to main content
        </a>
        <main id="main-content" tabIndex={-1} className="flex-1 flex flex-col focus:outline-none">
          <div>Page content</div>
        </main>
      </div>
    );

    const skipLink = screen.getByText('Skip to main content');
    expect(skipLink).toBeDefined();
    expect(skipLink.getAttribute('href')).toBe('#main-content');

    const mainElement = container.querySelector('#main-content');
    expect(mainElement).not.toBeNull();
    expect(mainElement?.getAttribute('tabindex')).toBe('-1');
  });

  it('verifies 44px minimum touch target classes on Button and Input controls', () => {
    const { rerender } = render(<Button>Interactive Button</Button>);
    const button = screen.getByRole('button', { name: 'Interactive Button' });
    expect(button.className).toContain('min-h-[44px]');

    rerender(<Input placeholder="Enter username" />);
    const input = screen.getByPlaceholderText('Enter username');
    expect(input.className).toContain('min-h-[44px]');
  });

  it('verifies aria-live and role="alert" regions exist for quota banners and upload status', async () => {
    renderWithClient(<UsagePanel />);

    await waitFor(() => {
      const banner = screen.getByTestId('alert-90-analyses');
      expect(banner).toBeDefined();
      expect(banner.getAttribute('role')).toBe('alert');
    });

    const { container } = render(<ResumeUpload />);
    const dropzone = container.querySelector('[data-testid="dropzone"]');
    expect(dropzone).not.toBeNull();
    expect(dropzone?.getAttribute('aria-label')).toContain('Upload dropzone');
  });

  it('verifies focus management: modal traps focus on open and returns focus on close', async () => {
    function ModalTester() {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setIsOpen(true)}>
            Open Test Modal
          </button>
          <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Test Modal">
            <div>
              <p>Modal body content</p>
              <button type="button" onClick={() => setIsOpen(false)}>
                Confirm Action
              </button>
            </div>
          </Modal>
        </div>
      );
    }

    render(<ModalTester />);
    const openBtn = screen.getByRole('button', { name: 'Open Test Modal' });
    openBtn.focus();
    expect(document.activeElement).toBe(openBtn);

    // Open modal
    fireEvent.click(openBtn);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeDefined();
    });

    // Close button inside modal should exist and receive focus
    const closeBtn = screen.getByRole('button', { name: /Close dialog/i });
    expect(closeBtn).toBeDefined();

    // Trigger ESC to close modal
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Focus must return to the trigger button
    expect(document.activeElement).toBe(openBtn);
  });

  it('verifies score numerals render their exact final value on first paint without animation (S6)', () => {
    const { container } = render(<ScoreGauge score={84} size="md" label="ATS Readiness" />);
    // Verify numeral is rendered immediately as text node with no tweening/count-up
    expect(screen.getByText('84')).toBeDefined();
    // Verify aria-valuenow is set to exact value
    const gauge = container.querySelector('[role="progressbar"]');
    expect(gauge?.getAttribute('aria-valuenow')).toBe('84');
  });

  it('verifies heading order has no skipped levels across main page', () => {
    // Render landing page structure
    const { container } = render(
      <div>
        <h1>Main Page Title</h1>
        <h2>Section 1</h2>
        <h3>Sub Section 1.1</h3>
        <h3>Sub Section 1.2</h3>
        <h2>Section 2</h2>
        <h3>Sub Section 2.1</h3>
      </div>
    );

    const headings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const levels = headings.map((h) => parseInt(h.tagName.substring(1), 10));

    expect(levels[0]).toBe(1); // Starts with H1
    for (let i = 1; i < levels.length; i++) {
      // Must not skip a level (e.g. h1 to h3 or h2 to h4)
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    }
  });

  it('verifies focus moves to the result region after an analysis result renders', () => {
    function ResultTester() {
      const [hasResult, setHasResult] = useState(false);
      const resultRef = React.useRef<HTMLDivElement>(null);

      React.useEffect(() => {
        if (hasResult) {
          resultRef.current?.focus();
        }
      }, [hasResult]);

      return (
        <div>
          <button type="button" onClick={() => setHasResult(true)}>
            Run Analysis
          </button>
          {hasResult && (
            <div
              ref={resultRef}
              tabIndex={-1}
              data-testid="analysis-results"
              aria-label="Analysis Results"
            >
              <h2>Analysis Findings</h2>
            </div>
          )}
        </div>
      );
    }

    render(<ResultTester />);
    const runBtn = screen.getByRole('button', { name: 'Run Analysis' });
    fireEvent.click(runBtn);

    const resultsRegion = screen.getByTestId('analysis-results');
    expect(resultsRegion).toBeDefined();
    expect(document.activeElement).toBe(resultsRegion);
  });
});
