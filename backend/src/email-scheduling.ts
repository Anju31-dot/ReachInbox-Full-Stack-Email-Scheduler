import { createHash } from 'node:crypto';
import { z } from 'zod';

export const emailSchema = z.object({
  recipients: z.array(z.string().trim().email()).min(1).max(500),
  subject: z.string().trim().min(1).max(998),
  body: z.string().min(1).max(100_000),
  scheduledAt: z.string().datetime({ offset: true }),
});

export type RateReservation = {
  waitMs: number;
  reason: 'hourly' | 'spacing' | null;
  hourlyLimitReached: boolean;
};

export function createIdempotencyKey(userId: string, clientKey: string): string {
  return createHash('sha256').update(`${userId}\u0000${clientKey}`).digest('hex');
}

export function parseRateReservation(value: unknown): RateReservation {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return { waitMs: value, reason: null, hourlyLimitReached: false };
  }

  if (
    !Array.isArray(value)
    || typeof value[0] !== 'number'
    || !Number.isFinite(value[0])
    || value[0] <= 0
    || (value[1] !== 'hourly' && value[1] !== 'spacing')
    || (value[2] !== 0 && value[2] !== 1)
  ) {
    throw new Error('Redis returned an invalid sender rate-limit reservation.');
  }

  return {
    waitMs: value[0],
    reason: value[1],
    hourlyLimitReached: value[2] === 1,
  };
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
