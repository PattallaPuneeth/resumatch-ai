/**
 * Usage-meter metrics: consumes by outcome, threshold crossings and refunds.
 * Labels are fixed enums only, never a user id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  initTelemetry,
  recordUsageConsume,
  recordUsageRefund,
  shutdownTelemetry,
} from '../telemetry.js';

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });

async function points(): Promise<Record<string, Array<{ attributes: Record<string, unknown>; value: unknown }>>> {
  await reader.forceFlush();
  const out: Record<string, Array<{ attributes: Record<string, unknown>; value: unknown }>> = {};
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        out[m.descriptor.name] = m.dataPoints.map((p) => ({
          attributes: p.attributes as Record<string, unknown>,
          value: p.value,
        }));
      }
    }
  }
  return out;
}

describe('usage-meter metrics', () => {
  beforeAll(() => {
    expect(initTelemetry('resumatch-backend-test', new InMemorySpanExporter(), reader)).toBe(true);
  });

  afterAll(async () => {
    await shutdownTelemetry();
  });

  it('counts consumes, threshold crossings and refunds without user ids', async () => {
    // Limit 10: 4 -> 5 crosses 50%, 6 -> 9 crosses 70% and 90%, then one blocked attempt
    recordUsageConsume('analyses', true, 5, 1, 10);
    recordUsageConsume('analyses', true, 9, 3, 10);
    recordUsageConsume('analyses', false, 9, 2, 10);
    recordUsageConsume('job_suggestions', true, 3, 1, null); // unlimited: no thresholds
    recordUsageRefund('analyses', 'verification');

    const p = await points();
    const consumed = p['resumatch.usage.consumed'];
    const count = (meter: string, outcome: string) =>
      consumed.find((d) => d.attributes.meter === meter && d.attributes.outcome === outcome)?.value;
    expect(count('analyses', 'allowed')).toBe(2);
    expect(count('analyses', 'blocked')).toBe(1);
    expect(count('job_suggestions', 'allowed')).toBe(1);

    const crossed = p['resumatch.usage.threshold_crossed']
      .map((d) => `${d.attributes.meter}:${d.attributes.threshold}`)
      .sort();
    expect(crossed).toEqual(['analyses:50', 'analyses:70', 'analyses:90']);

    expect(p['resumatch.usage.refunds'][0]).toEqual({
      attributes: { meter: 'analyses', reason: 'verification' },
      value: 1,
    });

    for (const series of Object.values(p)) {
      for (const d of series) {
        expect(Object.keys(d.attributes).every((k) => ['meter', 'outcome', 'threshold', 'reason'].includes(k))).toBe(true);
      }
    }
  });
});
