import { describe, expect, test } from 'bun:test';
import { InvestigationId, newId, OrgId } from '../ids.ts';
import {
  completeCollectorRun,
  failCollectorRun,
  missingInformationFrom,
  skipCollectorRun,
  startCollectorRun,
} from './collector-run.ts';

const orgId = newId(OrgId);
const investigationId = newId(InvestigationId);
const startedAt = new Date('2026-08-06T10:20:00.000Z');
const finishedAt = new Date('2026-08-06T10:20:04.000Z');

const start = (collector: string) =>
  startCollectorRun({ orgId, investigationId, collector, now: startedAt });

describe('lifecycle', () => {
  test('a new run is running', () => {
    expect(start('github').status).toBe('running');
  });

  test('completing records how much evidence it produced', () => {
    const run = completeCollectorRun(start('github'), 7, finishedAt);
    expect(run).toMatchObject({ status: 'succeeded', nodeCount: 7, finishedAt });
  });

  test('failing records the error', () => {
    const run = failCollectorRun(start('github'), 'HTTP 401 from api.github.com', finishedAt);
    expect(run).toMatchObject({ status: 'failed', error: 'HTTP 401 from api.github.com' });
  });

  test('skipping records why', () => {
    // Not configured is not the same as broken, and conflating them would tell an engineer to go
    // debug a collector that was never meant to run.
    const run = skipCollectorRun(start('github'), 'GITHUB_TOKEN is not set', finishedAt);
    expect(run).toMatchObject({ status: 'skipped', skippedReason: 'GITHUB_TOKEN is not set' });
  });

  test('rejects failing without an explanation', () => {
    expect(() => failCollectorRun(start('github'), '   ', finishedAt)).toThrow(/reason|error/i);
  });
});

describe('missingInformationFrom', () => {
  test('is empty when every collector succeeded', () => {
    const runs = [
      completeCollectorRun(start('github'), 3, finishedAt),
      completeCollectorRun(start('datadog'), 5, finishedAt),
    ];
    expect(missingInformationFrom(runs)).toEqual([]);
  });

  test('reports a collector that failed, and why', () => {
    const runs = [failCollectorRun(start('datadog'), 'request timed out', finishedAt)];
    const missing = missingInformationFrom(runs);

    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('datadog');
    expect(missing[0]).toContain('request timed out');
  });

  test('reports a collector that was skipped, and why', () => {
    const runs = [skipCollectorRun(start('github'), 'GITHUB_TOKEN is not set', finishedAt)];
    expect(missingInformationFrom(runs)[0]).toContain('GITHUB_TOKEN is not set');
  });

  test('reports a collector still running as incomplete', () => {
    expect(missingInformationFrom([start('github')])[0]).toContain('github');
  });

  test('omits collectors that succeeded', () => {
    const runs = [
      completeCollectorRun(start('github'), 3, finishedAt),
      failCollectorRun(start('datadog'), 'timeout', finishedAt),
    ];
    const missing = missingInformationFrom(runs);

    expect(missing).toHaveLength(1);
    expect(missing.join()).not.toContain('github');
  });

  test('orders gaps by collector name, so the report is stable across runs', () => {
    // Collectors finish in nondeterministic order; the report must not.
    const runs = [
      failCollectorRun(start('datadog'), 'timeout', finishedAt),
      failCollectorRun(start('argocd'), 'timeout', finishedAt),
    ];

    expect(missingInformationFrom(runs).map((line) => line.split(' ')[0])).toEqual([
      'argocd',
      'datadog',
    ]);
  });

  test('notes when a collector succeeded but found nothing', () => {
    // Distinguishing "no deploys happened" from "we could not look" matters: the first is a real
    // finding, the second is a blind spot.
    const runs = [completeCollectorRun(start('github'), 0, finishedAt)];
    expect(missingInformationFrom(runs)[0]).toMatch(/no evidence/i);
  });
});
