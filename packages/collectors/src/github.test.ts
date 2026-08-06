import { describe, expect, test } from 'bun:test';
import {
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  type Investigation,
  newId,
  OrgId,
  registerCoreKinds,
  systemClock,
} from '@trace/domain';
import type { EvidenceDraft } from './collector.ts';
import { githubCollector, githubCollectorFromEnv } from './github.ts';
import { collectEvidence } from './runner.ts';

const ALERT_AT = new Date('2026-08-06T10:16:00.000Z');
/** A full-length GitHub sha; the commit kind rejects anything longer than 40 characters. */
const SHA = '9f2c1ab'.padEnd(40, '0');

function investigation(): Investigation {
  return createInvestigation({
    orgId: newId(OrgId),
    externalRef: { system: 'pagerduty', id: 'INC-481' },
    window: defaultWindowFor(ALERT_AT),
    now: ALERT_AT,
  });
}

const deploymentJson = {
  id: 4821,
  sha: SHA,
  ref: 'v2.4.1',
  environment: 'production',
  created_at: '2026-08-06T10:12:00Z',
  creator: { login: 'ci-bot' },
};

const pullRequestJson = {
  number: 1893,
  title: 'Tune Redis connection pool for lower idle cost',
  user: { login: 'dmitri' },
  merged_at: '2026-08-06T09:58:00Z',
  merge_commit_sha: SHA,
  html_url: 'https://github.com/acme/payments-api/pull/1893',
};

const commitJson = {
  sha: SHA,
  html_url: 'https://github.com/acme/payments-api/commit/9f2c1ab',
  commit: {
    message: 'Reduce redis pool max from 50 to 5\n\nCuts idle connections in staging too.',
    author: { name: 'dmitri', date: '2026-08-06T09:41:00Z' },
  },
  author: { login: 'dmitri' },
};

interface FakeApi {
  deployments?: unknown[];
  statuses?: unknown[];
  pulls?: unknown[];
  pullDetail?: unknown;
  commits?: unknown[];
  /** Path fragment → status code, for the failure paths. */
  failWith?: { status: number; body?: unknown };
}

interface RecordedCall {
  url: string;
  headers: Headers;
}

function fakeFetch(api: FakeApi): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: new Headers(init?.headers) });

    if (api.failWith) {
      return new Response(JSON.stringify(api.failWith.body ?? {}), {
        status: api.failWith.status,
      });
    }

    const { pathname } = new URL(url);
    const body = pathname.endsWith('/statuses')
      ? (api.statuses ?? [{ state: 'success' }])
      : pathname.endsWith('/deployments')
        ? (api.deployments ?? [])
        : pathname.endsWith('/pulls')
          ? (api.pulls ?? [])
          : pathname.includes('/pulls/')
            ? (api.pullDetail ?? { additions: 12, deletions: 4, changed_files: 2 })
            : pathname.endsWith('/commits')
              ? (api.commits ?? [])
              : [];

    return new Response(JSON.stringify(body), { status: 200 });
  };

  return { fetch: impl as unknown as typeof fetch, calls };
}

async function collectFrom(api: FakeApi) {
  const { fetch, calls } = fakeFetch(api);
  const collector = githubCollector({
    token: 'ghp_test',
    repos: ['acme/payments-api'],
    fetch,
  });

  return { result: await collector.collect({ investigation: investigation() }), calls };
}

function payloadsOf(evidence: readonly EvidenceDraft[], kind: string): unknown[] {
  return evidence.filter((draft) => draft.kind === kind).map((draft) => draft.payload);
}

describe('the GitHub collector', () => {
  test('reports itself unavailable rather than failing when there is no token', () => {
    const collector = githubCollectorFromEnv({ TRACE_GITHUB_REPOS: 'acme/payments-api' });

    expect(collector.unavailableReason?.()).toBe('GITHUB_TOKEN is not set');
  });

  test('reports itself unavailable when no repositories are configured', () => {
    const collector = githubCollectorFromEnv({ GITHUB_TOKEN: 'ghp_test' });

    expect(collector.unavailableReason?.()).toBe('TRACE_GITHUB_REPOS is not set');
  });

  test('is available once a token and repositories are configured', () => {
    const collector = githubCollectorFromEnv({
      GITHUB_TOKEN: 'ghp_test',
      TRACE_GITHUB_REPOS: 'acme/payments-api, acme/checkout-web',
    });

    expect(collector.unavailableReason?.()).toBeUndefined();
  });

  test('authenticates and pins the API version', async () => {
    const { calls } = await collectFrom({ deployments: [deploymentJson] });

    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ghp_test');
    expect(calls[0]?.headers.get('x-github-api-version')).toBe('2022-11-28');
  });

  test('collects a deployment, resolving its outcome from the latest status', async () => {
    const { result } = await collectFrom({
      deployments: [deploymentJson],
      statuses: [{ state: 'failure' }],
    });

    expect(payloadsOf(result.evidence, 'deployment')).toEqual([
      {
        service: 'payments-api',
        version: 'v2.4.1',
        environment: 'production',
        status: 'failed',
        deployedAt: '2026-08-06T10:12:00.000Z',
        deployedBy: 'ci-bot',
        url: 'https://github.com/acme/payments-api/deployments/4821',
      },
    ]);
  });

  test('ignores a deployment that has not reached a terminal state', async () => {
    // "in_progress" has no honest mapping onto succeeded/failed/rolled_back, and guessing one
    // would put a claim into evidence.
    const { result } = await collectFrom({
      deployments: [deploymentJson],
      statuses: [{ state: 'in_progress' }],
    });

    expect(payloadsOf(result.evidence, 'deployment')).toEqual([]);
  });

  test('collects pull requests merged inside the window and no others', async () => {
    const { result } = await collectFrom({
      pulls: [
        pullRequestJson,
        { ...pullRequestJson, number: 1870, merged_at: '2026-08-05T11:00:00Z' },
        { ...pullRequestJson, number: 1899, merged_at: null },
      ],
    });

    expect(payloadsOf(result.evidence, 'pull_request')).toEqual([
      {
        repo: 'acme/payments-api',
        number: 1893,
        title: 'Tune Redis connection pool for lower idle cost',
        author: 'dmitri',
        mergedAt: '2026-08-06T09:58:00.000Z',
        additions: 12,
        deletions: 4,
        filesChanged: 2,
        url: 'https://github.com/acme/payments-api/pull/1893',
      },
    ]);
  });

  test('keeps only the subject line of a commit message', async () => {
    // The body is prose bound for a third-party LLM, and commit bodies carry stack traces,
    // co-author lists and occasionally secrets.
    const { result } = await collectFrom({ commits: [commitJson] });

    expect(payloadsOf(result.evidence, 'commit')).toEqual([
      {
        repo: 'acme/payments-api',
        sha: SHA,
        message: 'Reduce redis pool max from 50 to 5',
        author: 'dmitri',
        committedAt: '2026-08-06T09:41:00.000Z',
        url: 'https://github.com/acme/payments-api/commit/9f2c1ab',
      },
    ]);
  });

  test('asks GitHub for commits within the investigation window', async () => {
    const { calls } = await collectFrom({ commits: [commitJson] });
    const commitCall = calls.find((call) => call.url.includes('/commits'));

    expect(commitCall?.url).toContain('since=2026-08-06T09%3A16%3A00.000Z');
    expect(commitCall?.url).toContain('until=2026-08-06T10%3A31%3A00.000Z');
  });

  test('relates a deployment to the commit it shipped and the PR that merged it', async () => {
    const { result } = await collectFrom({
      deployments: [deploymentJson],
      pulls: [pullRequestJson],
      commits: [commitJson],
    });

    expect(result.relations?.map((relation) => relation.relation).sort()).toEqual([
      'INTRODUCED_BY',
      'INTRODUCED_BY',
      'PART_OF',
    ]);
  });

  test('fails with the status code, so the gap names something an operator can act on', async () => {
    const { fetch } = fakeFetch({ failWith: { status: 401 } });
    const collector = githubCollector({ token: 'bad', repos: ['acme/payments-api'], fetch });

    expect(collector.collect({ investigation: investigation() })).rejects.toThrow(
      /GitHub returned 401/,
    );
  });

  test('produces evidence its kinds accept', async () => {
    // The mapping above is only correct if the real schemas accept it, so this drives the drafts
    // through the actual runner rather than asserting on shapes.
    const { fetch } = fakeFetch({
      deployments: [deploymentJson],
      pulls: [pullRequestJson],
      commits: [commitJson],
    });
    const registry = new EvidenceKindRegistry();
    registerCoreKinds(registry);

    const result = await collectEvidence({
      collectors: [githubCollector({ token: 'ghp_test', repos: ['acme/payments-api'], fetch })],
      investigation: investigation(),
      registry,
      clock: systemClock,
    });

    expect(result.runs[0]?.status).toBe('succeeded');
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(3);
  });
});
