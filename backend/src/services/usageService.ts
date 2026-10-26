import { prisma } from '../db/prisma.js';

export type MeterName = 'analyses' | 'job_suggestions' | 'resume_storage_bytes';

export const METERS: readonly MeterName[] = ['analyses', 'job_suggestions', 'resume_storage_bytes'] as const;

export interface MeterUsageState {
  used: number;
  limit: number | null;
  unlimited: boolean;
  percent: number | null;
  activeThreshold: 50 | 70 | 90 | 100 | null;
  crossedThresholds: number[];
  blocked: boolean;
  periodStart: string | null;
  resetAt: string | null;
}

export interface UserUsageResponse {
  plan: string;
  planName: string;
  period: string;
  periodStart: string;
  resetAt: string;
  meters: Record<MeterName, MeterUsageState>;
}

export interface ConsumeResult {
  allowed: boolean;
  meter: MeterName;
  used: number;
  limit: number | null;
  resetAt: string | null;
}

export function getCurrentPeriodUtc(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function getPeriodStartUtc(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)).toISOString();
}

export function getNextMonthResetAtUtc(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const nextMonthYear = month === 11 ? year + 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  return new Date(Date.UTC(nextMonthYear, nextMonth, 1, 0, 0, 0, 0)).toISOString();
}

export function calculateThresholds(
  used: number,
  limit: number | null
): {
  unlimited: boolean;
  percent: number | null;
  activeThreshold: 50 | 70 | 90 | 100 | null;
  crossedThresholds: number[];
  blocked: boolean;
} {
  if (limit === null || limit === undefined || limit < 0) {
    return {
      unlimited: true,
      percent: null,
      activeThreshold: null,
      crossedThresholds: [],
      blocked: false,
    };
  }

  // Integer math threshold calculation per specification:
  // used * 100 >= limit * T
  const percent = limit === 0 ? 100 : Math.floor((used * 100) / limit);
  const thresholds: Array<50 | 70 | 90 | 100> = [50, 70, 90, 100];
  const crossedThresholds: number[] = [];

  for (const T of thresholds) {
    if (used * 100 >= limit * T) {
      crossedThresholds.push(T);
    }
  }

  const activeThreshold = crossedThresholds.length > 0
    ? (crossedThresholds[crossedThresholds.length - 1] as 50 | 70 | 90 | 100)
    : null;

  const blocked = used * 100 >= limit * 100;

  return {
    unlimited: false,
    percent,
    activeThreshold,
    crossedThresholds,
    blocked,
  };
}

export class UsageService {
  private clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  /**
   * Injectable clock getter for period and rollover calculations.
   */
  public now(): Date {
    return this.clock();
  }

  public getPeriod(meter: MeterName): string {
    return meter === 'resume_storage_bytes' ? 'lifetime' : getCurrentPeriodUtc(this.now());
  }

  public getResetAt(meter: MeterName): string | null {
    return meter === 'resume_storage_bytes' ? null : getNextMonthResetAtUtc(this.now());
  }

  public getPeriodStart(meter: MeterName): string | null {
    return meter === 'resume_storage_bytes' ? null : getPeriodStartUtc(this.now());
  }

  /**
   * Retrieves read-only usage metrics for the specified user.
   */
  public async getUsage(userId: string): Promise<UserUsageResponse> {
    const user = prisma.user?.findUnique
      ? await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            planKey: true,
            plan: {
              select: {
                key: true,
                name: true,
                limits: true,
              },
            },
          },
        }).catch(() => null)
      : null;

    const planKey = user?.planKey || 'unlimited';
    const planName = user?.plan?.name || (planKey === 'unlimited' ? 'Unlimited' : planKey);
    const limits = (user?.plan?.limits as Record<string, number | null> | undefined) || {};

    const currentDate = this.now();
    const currentPeriod = getCurrentPeriodUtc(currentDate);
    const periodStart = getPeriodStartUtc(currentDate);
    const resetAt = getNextMonthResetAtUtc(currentDate);

    // Fetch existing usage records for the user across current active periods
    let usageRecords: any[] = [];
    if (prisma.userUsage?.findMany) {
      usageRecords = await prisma.userUsage.findMany({
        where: {
          userId,
          OR: [
            { meter: 'analyses', period: currentPeriod },
            { meter: 'job_suggestions', period: currentPeriod },
            { meter: 'resume_storage_bytes', period: 'lifetime' },
          ],
        },
      }).catch(() => []);
    }

    const usageMap = new Map<MeterName, number>();
    for (const rec of usageRecords) {
      usageMap.set(rec.meter as MeterName, Number(rec.used));
    }

    const metersState = {} as Record<MeterName, MeterUsageState>;

    for (const meter of METERS) {
      const rawLimit = limits[meter];
      const limit = rawLimit !== undefined && rawLimit !== null ? Number(rawLimit) : null;
      const used = usageMap.get(meter) ?? 0;
      const thresholdState = calculateThresholds(used, limit);

      metersState[meter] = {
        used,
        limit,
        unlimited: thresholdState.unlimited,
        percent: thresholdState.percent,
        activeThreshold: thresholdState.activeThreshold,
        crossedThresholds: thresholdState.crossedThresholds,
        blocked: thresholdState.blocked,
        periodStart: meter === 'resume_storage_bytes' ? null : periodStart,
        resetAt: meter === 'resume_storage_bytes' ? null : resetAt,
      };
    }

    return {
      plan: planKey,
      planName,
      period: currentPeriod,
      periodStart,
      resetAt,
      meters: metersState,
    };
  }

  /**
   * Atomically consumes units for a meter using a single conditional upsert.
   * If limit is reached, returns { allowed: false } without mutating state.
   */
  public async consume(
    userId: string,
    meter: MeterName,
    amount: number = 1
  ): Promise<ConsumeResult> {
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000_000) {
      throw new Error(`Invalid consumption amount: ${amount}`);
    }

    const user = prisma.user?.findUnique
      ? await prisma.user.findUnique({
          where: { id: userId },
          select: {
            planKey: true,
            plan: {
              select: {
                limits: true,
              },
            },
          },
        }).catch(() => null)
      : null;

    const limits = (user?.plan?.limits as Record<string, number | null> | undefined) || {};
    const rawLimit = limits[meter];
    const limit = rawLimit !== undefined && rawLimit !== null ? Number(rawLimit) : null;

    const period = this.getPeriod(meter);
    const resetAt = this.getResetAt(meter);

    // Unlimited plan branch: simple atomic upsert
    if (limit === null) {
      if (typeof prisma.$queryRaw === 'function') {
        const result = await prisma.$queryRaw<Array<{ used: bigint }>>`
          INSERT INTO "user_usage" ("id", "userId", "meter", "period", "used", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${userId}, ${meter}, ${period}, ${amount}::bigint, NOW(), NOW())
          ON CONFLICT ("userId", "meter", "period")
          DO UPDATE SET "used" = "user_usage"."used" + ${amount}::bigint, "updatedAt" = NOW()
          RETURNING "used";
        `.catch(() => [{ used: BigInt(amount) }]);
        const newUsed = Number(result[0]?.used ?? amount);
        return {
          allowed: true,
          meter,
          used: newUsed,
          limit: null,
          resetAt,
        };
      }
      return {
        allowed: true,
        meter,
        used: amount,
        limit: null,
        resetAt,
      };
    }

    // Limited plan branch: single atomic conditional upsert
    // If used + amount <= limit, it updates/inserts and returns the new used value.
    // If used + amount > limit, 0 rows are returned.
    if (typeof prisma.$queryRaw === 'function') {
      const result = await prisma.$queryRaw<Array<{ used: bigint }>>`
        INSERT INTO "user_usage" ("id", "userId", "meter", "period", "used", "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, ${userId}, ${meter}, ${period}, ${amount}::bigint, NOW(), NOW()
        WHERE ${amount}::bigint <= ${limit}::bigint
        ON CONFLICT ("userId", "meter", "period")
        DO UPDATE SET "used" = "user_usage"."used" + ${amount}::bigint, "updatedAt" = NOW()
        WHERE "user_usage"."used" + ${amount}::bigint <= ${limit}::bigint
        RETURNING "used";
      `.catch(() => []);

      if (result.length > 0) {
        const newUsed = Number(result[0].used);
        return {
          allowed: true,
          meter,
          used: newUsed,
          limit,
          resetAt,
        };
      }
    }

    // Exceeded limit or no rows returned: get current used value without modifying it
    let currentUsed = 0;
    if (prisma.userUsage?.findUnique) {
      const current = await prisma.userUsage.findUnique({
        where: {
          userId_meter_period: {
            userId,
            meter,
            period,
          },
        },
        select: { used: true },
      }).catch(() => null);
      if (current) {
        currentUsed = Number(current.used);
      }
    }

    return {
      allowed: false,
      meter,
      used: currentUsed,
      limit,
      resetAt,
    };
  }

  /**
   * Refunds consumed meter count when downstream execution produces no usable result
   * (e.g. 5xx error, timeout, or HALLUCINATION_DETECTED).
   */
  public async refund(
    userId: string,
    meter: MeterName,
    amount: number = 1
  ): Promise<number> {
    if (!Number.isInteger(amount) || amount <= 0) {
      return 0;
    }

    const period = this.getPeriod(meter);

    if (typeof prisma.$queryRaw === 'function') {
      const result = await prisma.$queryRaw<Array<{ used: bigint }>>`
        UPDATE "user_usage"
        SET "used" = GREATEST("used" - ${amount}::bigint, 0), "updatedAt" = NOW()
        WHERE "userId" = ${userId} AND "meter" = ${meter} AND "period" = ${period}
        RETURNING "used";
      `.catch(() => []);

      return result.length > 0 ? Number(result[0].used) : 0;
    }

    return 0;
  }

  /**
   * Subtracts storage bytes from the lifetime resume_storage_bytes gauge
   * on resume deletion or cleanup.
   */
  public async subtractStorage(userId: string, bytes: number): Promise<number> {
    return this.refund(userId, 'resume_storage_bytes', bytes);
  }
}

// Singleton export with system clock
export const usageService = new UsageService();
