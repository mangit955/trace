import { INC_481, type SeededIncident } from './incident-481.ts';

export {
  fixtureCollectors,
  INC_481,
  type SeededIncident,
  type SeededSource,
} from './incident-481.ts';

/**
 * Every incident the credential-free demo can investigate, keyed by the id a user types.
 *
 * Kept deliberately small. Each seeded incident also needs a captured reasoning response so the
 * demo works without an API key, so incidents are a pair of artefacts, not just data.
 */
export const SEEDED_INCIDENTS: Readonly<Record<string, SeededIncident>> = {
  [INC_481.externalRef.id]: INC_481,
};

/** Looks up a seeded incident, tolerating however the user capitalised it. */
export function seededIncident(externalId: string): SeededIncident | undefined {
  const wanted = externalId.trim().toLowerCase();
  return Object.values(SEEDED_INCIDENTS).find(
    (incident) => incident.externalRef.id.toLowerCase() === wanted,
  );
}
