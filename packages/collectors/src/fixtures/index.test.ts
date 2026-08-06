import { describe, expect, test } from 'bun:test';
import { SEEDED_INCIDENTS, seededIncident } from './index.ts';

describe('the seeded incident catalogue', () => {
  test('resolves an incident by the id a user would type', () => {
    expect(seededIncident('INC-481')?.externalRef.id).toBe('INC-481');
  });

  test('is case-insensitive, because nobody shouts an incident id at 3am', () => {
    expect(seededIncident('inc-481')?.externalRef.id).toBe('INC-481');
  });

  test('returns nothing for an id it does not have', () => {
    expect(seededIncident('INC-999')).toBeUndefined();
  });

  test('keys every incident by its own external id', () => {
    for (const [id, incident] of Object.entries(SEEDED_INCIDENTS)) {
      expect(incident.externalRef.id).toBe(id);
    }
  });
});
