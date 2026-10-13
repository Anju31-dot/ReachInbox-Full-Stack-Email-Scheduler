import { describe, expect, it } from 'vitest';
import { parseRecipientCsv } from './recipient-import';

describe('parseRecipientCsv', () => {
  it('reads a header-based CSV, normalizes addresses, and removes duplicates', () => {
    expect(parseRecipientCsv('Name,Email\nAda, ADA@example.com\nGrace,grace@example.com\nOther,ada@example.com')).toEqual({
      recipients: ['ada@example.com', 'grace@example.com'],
      invalid: [],
    });
  });

  it('accepts an email-only CSV without a header', () => {
    expect(parseRecipientCsv('first@example.com\nsecond@example.com')).toEqual({
      recipients: ['first@example.com', 'second@example.com'],
      invalid: [],
    });
  });

  it('reports invalid cell values without discarding valid recipients', () => {
    expect(parseRecipientCsv('first@example.com,not an address;second@example.com')).toEqual({
      recipients: ['first@example.com', 'second@example.com'],
      invalid: ['not', 'an', 'address'],
    });
  });
});
