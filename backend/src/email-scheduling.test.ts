import { createIdempotencyKey, emailSchema, parseRateReservation, positiveInteger } from './email-scheduling';

describe('email scheduling input validation', () => {
  const future = '2030-01-01T00:00:00.000Z';

  it('trims and validates each recipient', () => {
    expect(emailSchema.parse({
      recipients: [' first@example.com '],
      subject: '  Update  ',
      body: 'Message',
      scheduledAt: future,
    })).toMatchObject({ recipients: ['first@example.com'], subject: 'Update' });
  });

  it.each([
    { recipients: [], subject: 'Hi', body: 'Message', scheduledAt: future },
    { recipients: ['not-an-email'], subject: 'Hi', body: 'Message', scheduledAt: future },
    { recipients: ['first@example.com'], subject: ' ', body: 'Message', scheduledAt: future },
    { recipients: ['first@example.com'], subject: 'Hi', body: '', scheduledAt: future },
    { recipients: ['first@example.com'], subject: 'Hi', body: 'Message', scheduledAt: 'not-a-date' },
  ])('rejects invalid email payloads', (payload) => {
    expect(emailSchema.safeParse(payload).success).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('is stable for the same user and request key', () => {
    expect(createIdempotencyKey('user-1', 'request-1')).toBe(createIdempotencyKey('user-1', 'request-1'));
  });

  it('isolates identical client keys between tenants', () => {
    expect(createIdempotencyKey('user-1', 'request-1')).not.toBe(createIdempotencyKey('user-2', 'request-1'));
  });
});

describe('rate reservation result parsing', () => {
  it('treats an immediate Redis reservation as allowed', () => {
    expect(parseRateReservation(0)).toEqual({ waitMs: 0, reason: null, hourlyLimitReached: false });
  });

  it('retains the wait reason and hourly-limit flag', () => {
    expect(parseRateReservation([3600000, 'hourly', 1])).toEqual({
      waitMs: 3600000,
      reason: 'hourly',
      hourlyLimitReached: true,
    });
    expect(parseRateReservation([2000, 'spacing', 0])).toEqual({
      waitMs: 2000,
      reason: 'spacing',
      hourlyLimitReached: false,
    });
  });

  it('rejects malformed Redis results instead of sending without a reservation', () => {
    expect(() => parseRateReservation('0')).toThrow(/invalid sender rate-limit reservation/i);
    expect(() => parseRateReservation([-1, 'spacing', 0])).toThrow(/invalid sender rate-limit reservation/i);
    expect(() => parseRateReservation([100, 'other', 0])).toThrow(/invalid sender rate-limit reservation/i);
  });
});

describe('configuration integer parsing', () => {
  it('uses a safe positive integer and falls back for invalid values', () => {
    expect(positiveInteger('12', 3)).toBe(12);
    expect(positiveInteger('-1', 3)).toBe(3);
    expect(positiveInteger('1.5', 3)).toBe(3);
    expect(positiveInteger('Infinity', 3)).toBe(3);
    expect(positiveInteger(undefined, 3)).toBe(3);
  });
});
