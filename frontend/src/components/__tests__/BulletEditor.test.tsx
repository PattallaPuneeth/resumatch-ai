import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BulletEditor } from '../BulletEditor';
import { apiClient, ApiProblemError } from '../../lib/apiClient';

vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/apiClient')>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      rewriter: {
        rewriteBullet: vi.fn(),
      },
    },
  };
});

describe('BulletEditor Component', () => {
  const resumeId = '11111111-1111-1111-1111-111111111111';
  const sampleBullets = [
    'Architected distributed microservices handling 50k requests per second.',
    'Optimized PostgreSQL queries reducing p99 latency from 450ms to 85ms.',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders initial state with bullet selection and quota notice', () => {
    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
        analysesMeter={{ used: 3, limit: 10 }}
      />
    );

    expect(screen.getByText('Fact-Grounded STAR Bullet Rewriter')).toBeDefined();
    expect(screen.getByText(/3 \/ 10 used/)).toBeDefined();
    expect(screen.getByRole('button', { name: /Rewrite Bullet/i })).toBeDefined();
  });

  it('triggers rewrite on button click and renders word diff and grounded evidence', async () => {
    vi.mocked(apiClient.rewriter.rewriteBullet).mockResolvedValueOnce({
      status: 'SUCCESS',
      originalBullet: sampleBullets[0],
      options: [
        {
          text: 'Architected high-throughput microservices handling 50,000 requests per second with 99.99% uptime.',
          evidenceSpans: [
            {
              startChar: 10,
              endChar: 45,
              quote: 'handling 50k requests per second',
            },
          ],
        },
      ],
      provider: 'openrouter',
      model: 'meta-llama/llama-3.3-70b-instruct',
    });

    const onUsageChange = vi.fn();
    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
        analysesMeter={{ used: 1, limit: 5 }}
        onUsageChange={onUsageChange}
      />
    );

    const button = screen.getByRole('button', { name: /Rewrite Bullet/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/Verified STAR Rewrite Options/i)).toBeDefined();
    });

    expect(screen.getByText(/100% Fact-Grounded/i)).toBeDefined();
    expect(screen.getByText(/Grounded Evidence in Source Resume/i)).toBeDefined();
    expect(screen.getAllByText(/handling 50k requests per second/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/chars 10–45/i)).toBeDefined();
    expect(onUsageChange).toHaveBeenCalled();
  });

  it('handles 422 HALLUCINATION_DETECTED with plain-language message and refetches usage', async () => {
    vi.mocked(apiClient.rewriter.rewriteBullet).mockRejectedValueOnce(
      new ApiProblemError(422, {
        type: 'https://api.resumatch.ai/errors/hallucination-detected',
        title: 'Hallucination Detected',
        detail: 'HALLUCINATION_DETECTED: No rewritten options could be verified against source facts.',
      })
    );

    const onUsageChange = vi.fn();
    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
        analysesMeter={{ used: 1, limit: 5 }}
        onUsageChange={onUsageChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Rewrite Bullet/i }));

    await waitFor(() => {
      expect(screen.getByText(/Factual Verification Guard Triggered/i)).toBeDefined();
    });

    expect(
      screen.getByText(/The rewrite was rejected because it contained facts not found in your resume; you were not charged/i)
    ).toBeDefined();
    expect(onUsageChange).toHaveBeenCalled();
  });

  it('handles 429 usage limit exceeded banner', async () => {
    vi.mocked(apiClient.rewriter.rewriteBullet).mockRejectedValueOnce(
      new ApiProblemError(429, {
        type: 'https://api.resumatch.ai/errors/usage-limit-exceeded',
        title: 'Usage Limit Exceeded',
        detail: 'Usage limit reached for meter "analyses".',
      })
    );

    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
        analysesMeter={{ used: 5, limit: 5 }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Rewrite Bullet/i }));

    await waitFor(() => {
      expect(screen.getByText(/Usage Limit Exceeded/i)).toBeDefined();
    });
  });

  it('handles 503 unavailable with retry state', async () => {
    vi.mocked(apiClient.rewriter.rewriteBullet).mockRejectedValueOnce(
      new ApiProblemError(503, {
        type: 'https://api.resumatch.ai/errors/service-unavailable',
        title: 'Service Unavailable',
        detail: 'ML rewriter service is currently unavailable',
      })
    );

    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
        analysesMeter={{ used: 0, limit: 5 }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Rewrite Bullet/i }));

    await waitFor(() => {
      expect(screen.getByText(/AI Rewriter Unavailable/i)).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /Retry/i })).toBeDefined();
  });

  it('renders malicious strings in evidence quotes inertly as text', async () => {
    const maliciousPayload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    vi.mocked(apiClient.rewriter.rewriteBullet).mockResolvedValueOnce({
      status: 'SUCCESS',
      originalBullet: sampleBullets[0],
      options: [
        {
          text: `Rewritten safe text ${maliciousPayload}`,
          evidenceSpans: [
            {
              startChar: 0,
              endChar: 50,
              quote: maliciousPayload,
            },
          ],
        },
      ],
    });

    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Rewrite Bullet/i }));

    await waitFor(() => {
      expect(screen.getByText(/100% Fact-Grounded/i)).toBeDefined();
    });

    // Verify raw tags are not executed or inserted as HTML elements
    expect(document.querySelector('script')).toBeNull();
    const alertEls = screen.getAllByText((content) => content.includes('<script>'));
    expect(alertEls.length).toBeGreaterThan(0);
  });

  it('triggers copy to clipboard and shows temporary confirmation text', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    vi.mocked(apiClient.rewriter.rewriteBullet).mockResolvedValueOnce({
      status: 'SUCCESS',
      originalBullet: sampleBullets[0],
      options: [
        {
          text: 'Architected high-throughput microservices.',
          evidenceSpans: [],
        },
      ],
    });

    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Rewrite Bullet/i }));

    await waitFor(() => {
      expect(screen.getByText('Copy Rewritten Bullet')).toBeDefined();
    });

    const copyBtn = screen.getByRole('button', { name: /Copy Rewritten Bullet/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('Architected high-throughput microservices.');
      expect(screen.getByText(/Copied to Clipboard/i)).toBeDefined();
    });
  });

  it('handles timeout state with retry', async () => {
    vi.mocked(apiClient.rewriter.rewriteBullet).mockRejectedValueOnce(
      new Error('Request timed out after 30000ms')
    );

    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Rewrite Bullet/i }));

    await waitFor(() => {
      expect(screen.getByText(/AI bullet rewriter timed out/i)).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /Retry/i })).toBeDefined();
  });

  it('renders malicious strings inertly (<script>, javascript: URLs, RTL, 100k-character string)', async () => {
    const huge100k = 'A'.repeat(100000);
    const rtlWord = 'مرحبا';
    const jsUrl = 'javascript:alert(document.cookie)';
    const scriptTag = '<script>window.__xss=true;</script>';

    vi.mocked(apiClient.rewriter.rewriteBullet).mockResolvedValueOnce({
      status: 'SUCCESS',
      originalBullet: sampleBullets[0],
      options: [
        {
          text: `Safe start ${jsUrl} ${rtlWord} ${scriptTag} ${huge100k}`,
          evidenceSpans: [
            {
              startChar: 0,
              endChar: 40,
              quote: `${jsUrl} ${scriptTag}`,
            },
          ],
        },
      ],
    });

    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Rewrite Bullet/i }));

    await waitFor(() => {
      expect(screen.getByText(/100% Fact-Grounded/i)).toBeDefined();
    });

    // Zero script tags executed or present in DOM
    expect(document.querySelector('script')).toBeNull();
    expect((window as any).__xss).toBeUndefined();

    // Verify raw text is rendered inertly as text node
    expect(screen.getAllByText((content) => content.includes('javascript:alert')).length).toBeGreaterThan(0);
    expect(screen.getAllByText((content) => content.includes(rtlWord)).length).toBeGreaterThan(0);
  });

  it('handles clipboard write failure gracefully', async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'));
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    vi.mocked(apiClient.rewriter.rewriteBullet).mockResolvedValueOnce({
      status: 'SUCCESS',
      originalBullet: sampleBullets[0],
      options: [
        {
          text: 'Architected high-throughput microservices.',
          evidenceSpans: [],
        },
      ],
    });

    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Rewrite Bullet/i }));

    await waitFor(() => {
      expect(screen.getByText('Copy Rewritten Bullet')).toBeDefined();
    });

    const copyBtn = screen.getByRole('button', { name: /Copy Rewritten Bullet/i });
    expect(() => fireEvent.click(copyBtn)).not.toThrow();
  });

  it('renders evidence highlights inside original context with diff legend', async () => {
    vi.mocked(apiClient.rewriter.rewriteBullet).mockResolvedValueOnce({
      status: 'SUCCESS',
      originalBullet: sampleBullets[0],
      options: [
        {
          text: 'Architected distributed microservices with Redis queues.',
          evidenceSpans: [
            {
              startChar: 12,
              endChar: 40,
              quote: 'distributed microservices',
            },
          ],
        },
      ],
    });

    render(
      <BulletEditor
        resumeId={resumeId}
        bullets={sampleBullets}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Rewrite Bullet/i }));

    await waitFor(() => {
      expect(screen.getByText(/Diff Legend/i)).toBeDefined();
      expect(screen.getByText(/Added words/i)).toBeDefined();
      expect(screen.getByText(/Removed words/i)).toBeDefined();
      expect(screen.getByText(/Grounded Evidence in Source Resume/i)).toBeDefined();
    });
  });
});

