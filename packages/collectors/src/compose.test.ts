import { describe, expect, test } from 'bun:test';
import type { Collector } from './collector.ts';
import { selectCollectors } from './compose.ts';

function collector(name: string, unavailable?: string): Collector {
  return {
    name,
    ...(unavailable === undefined ? {} : { unavailableReason: () => unavailable }),
    collect: async () => ({ evidence: [] }),
  };
}

const seeded = [collector('github'), collector('pagerduty')];

function namesFrom(collectors: readonly Collector[]): string[] {
  return collectors.map((entry) => entry.name);
}

describe('selectCollectors', () => {
  test('replaces a seeded source with the live collector of the same name', () => {
    const live = collector('github');

    const chosen = selectCollectors({ seeded, live: [live] });

    expect(chosen.find((entry) => entry.name === 'github')).toBe(live);
    expect(namesFrom(chosen)).toEqual(['github', 'pagerduty']);
  });

  test('leaves the seeded source in place when the live collector is unconfigured', () => {
    // Otherwise the credential-free demo reports "github was not consulted" while showing the
    // GitHub evidence the seed provided.
    const chosen = selectCollectors({
      seeded,
      live: [collector('github', 'GITHUB_TOKEN is not set')],
    });

    expect(chosen.find((entry) => entry.name === 'github')).toBe(seeded[0]);
  });

  test('keeps an unconfigured live collector that no seed covers, so its gap is reported', () => {
    const chosen = selectCollectors({
      seeded,
      live: [collector('datadog', 'DATADOG_API_KEY is not set')],
    });

    expect(namesFrom(chosen)).toEqual(['datadog', 'github', 'pagerduty']);
  });

  test('is usable with no seeds at all, which is what production runs', () => {
    const chosen = selectCollectors({ live: [collector('github')] });

    expect(namesFrom(chosen)).toEqual(['github']);
  });

  test('returns collectors in a stable order whatever order they were passed in', () => {
    const forward = selectCollectors({ seeded, live: [collector('datadog')] });
    const reverse = selectCollectors({
      seeded: [...seeded].reverse(),
      live: [collector('datadog')],
    });

    expect(namesFrom(forward)).toEqual(namesFrom(reverse));
  });
});
