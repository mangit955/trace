import { commitKind, deploymentKind, pullRequestKind, type TimeWindow } from '@trace/domain';
import {
  type Collector,
  type CollectorContext,
  type CollectorResult,
  draft,
  type EvidenceDraft,
  keyOf,
  type RelationDraft,
} from './collector.ts';

/**
 * The real GitHub collector: deployments, merged pull requests and commits in the incident window.
 *
 * GitHub is the highest-signal source Trace can reach with a single free credential, which is why
 * it is the one real connector in this cut. It activates only when `GITHUB_TOKEN` is present; with
 * no credentials it reports itself unavailable and the investigation records that as a known gap
 * rather than pretending nothing shipped.
 *
 * Everything here maps third-party JSON onto evidence kinds. Two rules govern that mapping: never
 * invent a field the API did not state (an unknown deployment outcome is dropped, not guessed),
 * and never carry unbounded text across (commit bodies are cut to their subject line).
 */

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Enough to cover an hour of activity on a busy repo without paginating. */
const PER_PAGE = 100;

export interface GitHubCollectorOptions {
  token: string | undefined;
  /** `owner/name`, as they appear in a GitHub URL. */
  repos: readonly string[];
  baseUrl?: string;
  /** Injected so the collector is testable without a network or a token. */
  fetch?: typeof fetch;
}

/** The subset of the environment this collector reads. */
export interface GitHubEnv {
  GITHUB_TOKEN?: string | undefined;
  TRACE_GITHUB_REPOS?: string | undefined;
}

/**
 * Builds the collector from environment variables.
 *
 * Always returns a collector, even when nothing is configured. Registering it unconditionally is
 * what turns "no GitHub token" into a stated blind spot in the report instead of silence.
 */
export function githubCollectorFromEnv(env: GitHubEnv = process.env as GitHubEnv): Collector {
  return githubCollector({
    token: env.GITHUB_TOKEN,
    repos: (env.TRACE_GITHUB_REPOS ?? '')
      .split(',')
      .map((repo) => repo.trim())
      .filter((repo) => repo.length > 0),
  });
}

export function githubCollector(options: GitHubCollectorOptions): Collector {
  const call = requester(options);

  return {
    name: 'github',

    unavailableReason() {
      if (!options.token) return 'GITHUB_TOKEN is not set';
      if (options.repos.length === 0) return 'TRACE_GITHUB_REPOS is not set';
      return undefined;
    },

    async collect(ctx: CollectorContext): Promise<CollectorResult> {
      // Repositories are independent, so one slow repo should not serialize behind another.
      const perRepo = await Promise.all(
        options.repos.map((repo) => collectRepo(call, repo, ctx.investigation.window)),
      );

      return {
        evidence: perRepo.flatMap((result) => result.evidence),
        relations: perRepo.flatMap((result) => result.relations ?? []),
      };
    },
  };
}

async function collectRepo(
  call: Requester,
  repo: string,
  window: TimeWindow,
): Promise<CollectorResult> {
  const [deployments, pulls, commits] = await Promise.all([
    collectDeployments(call, repo, window),
    collectPullRequests(call, repo, window),
    collectCommits(call, repo, window),
  ]);

  return {
    evidence: [...deployments.evidence, ...pulls.evidence, ...commits.evidence],
    relations: relate(deployments.payloads, pulls.payloads, commits.payloads),
  };
}

/**
 * Links the three kinds by the shas GitHub already agrees on.
 *
 * Provenance, not causation: "this release contains that code" is a fact the API states. Whether
 * the code broke anything is a claim, and claims live in hypotheses.
 */
function relate(
  deployments: readonly DeploymentPayload[],
  pulls: readonly PullRequestPayloadWithSha[],
  commits: readonly CommitPayload[],
): RelationDraft[] {
  const relations: RelationDraft[] = [];

  for (const deployment of deployments) {
    const commit = commits.find((candidate) => candidate.sha === deployment.sha);
    if (commit) {
      relations.push({
        from: keyOf(deploymentKind, deployment.payload),
        to: keyOf(commitKind, commit),
        relation: 'INTRODUCED_BY',
      });
    }

    const pull = pulls.find((candidate) => candidate.mergeCommitSha === deployment.sha);
    if (pull) {
      relations.push({
        from: keyOf(deploymentKind, deployment.payload),
        to: keyOf(pullRequestKind, pull.payload),
        relation: 'INTRODUCED_BY',
      });
    }
  }

  for (const pull of pulls) {
    const merge = commits.find((candidate) => candidate.sha === pull.mergeCommitSha);
    if (merge) {
      relations.push({
        from: keyOf(commitKind, merge),
        to: keyOf(pullRequestKind, pull.payload),
        relation: 'PART_OF',
      });
    }
  }

  return relations;
}

type DeploymentPayload = { sha: string; payload: Parameters<typeof deploymentKind.identity>[0] };
type PullRequestPayloadWithSha = {
  mergeCommitSha: string | undefined;
  payload: Parameters<typeof pullRequestKind.identity>[0];
};
type CommitPayload = Parameters<typeof commitKind.identity>[0];

interface GitHubDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  created_at: string;
  creator?: { login?: string } | null;
}

async function collectDeployments(
  call: Requester,
  repo: string,
  window: TimeWindow,
): Promise<{ evidence: EvidenceDraft[]; payloads: DeploymentPayload[] }> {
  const deployments = await call<GitHubDeployment[]>(`/repos/${repo}/deployments`, {
    per_page: String(PER_PAGE),
  });

  const inWindow = deployments.filter((deployment) => within(deployment.created_at, window));

  const statuses = await Promise.all(
    inWindow.map((deployment) =>
      call<{ state?: string }[]>(`/repos/${repo}/deployments/${deployment.id}/statuses`, {
        per_page: '1',
      }),
    ),
  );

  const payloads: DeploymentPayload[] = [];

  for (const [index, deployment] of inWindow.entries()) {
    const status = terminalStatus(statuses[index]?.[0]?.state);
    // A deployment still in flight has no honest mapping onto the kind's outcomes, and inventing
    // one would put a guess into evidence. It is dropped, and the absence is visible as a gap.
    if (status === undefined) continue;

    payloads.push({
      sha: deployment.sha,
      payload: {
        service: serviceNameOf(repo),
        version: deployment.ref,
        environment: deployment.environment,
        status,
        deployedAt: isoOf(deployment.created_at),
        deployedBy: deployment.creator?.login ?? 'unknown',
        url: `https://github.com/${repo}/deployments/${deployment.id}`,
      },
    });
  }

  return { evidence: payloads.map((item) => draft(deploymentKind, item.payload)), payloads };
}

function terminalStatus(
  state: string | undefined,
): 'succeeded' | 'failed' | 'rolled_back' | undefined {
  switch (state) {
    case 'success':
      return 'succeeded';
    case 'failure':
    case 'error':
      return 'failed';
    case 'inactive':
      return 'rolled_back';
    default:
      return undefined;
  }
}

interface GitHubPullRequest {
  number: number;
  title: string;
  user?: { login?: string } | null;
  merged_at: string | null;
  merge_commit_sha?: string | null;
  html_url?: string;
}

async function collectPullRequests(
  call: Requester,
  repo: string,
  window: TimeWindow,
): Promise<{ evidence: EvidenceDraft[]; payloads: PullRequestPayloadWithSha[] }> {
  const pulls = await call<GitHubPullRequest[]>(`/repos/${repo}/pulls`, {
    state: 'closed',
    sort: 'updated',
    direction: 'desc',
    per_page: String(PER_PAGE),
  });

  const merged = pulls.filter((pull) => pull.merged_at !== null && within(pull.merged_at, window));

  // Diff size only appears on the single-PR endpoint, and it is the field that tells an
  // investigator whether a change was a one-line tweak or a rewrite. Worth the extra call, of
  // which there are as many as there were merges during the incident window.
  const details = await Promise.all(
    merged.map((pull) =>
      call<{ additions?: number; deletions?: number; changed_files?: number }>(
        `/repos/${repo}/pulls/${pull.number}`,
      ),
    ),
  );

  const payloads = merged.map((pull, index) => ({
    mergeCommitSha: pull.merge_commit_sha ?? undefined,
    payload: {
      repo,
      number: pull.number,
      title: pull.title,
      author: pull.user?.login ?? 'unknown',
      mergedAt: isoOf(pull.merged_at ?? ''),
      additions: details[index]?.additions ?? 0,
      deletions: details[index]?.deletions ?? 0,
      filesChanged: details[index]?.changed_files ?? 0,
      ...(pull.html_url === undefined ? {} : { url: pull.html_url }),
    },
  }));

  return { evidence: payloads.map((item) => draft(pullRequestKind, item.payload)), payloads };
}

interface GitHubCommit {
  sha: string;
  html_url?: string;
  commit: { message: string; author?: { name?: string; date?: string } | null };
  author?: { login?: string } | null;
}

async function collectCommits(
  call: Requester,
  repo: string,
  window: TimeWindow,
): Promise<{ evidence: EvidenceDraft[]; payloads: CommitPayload[] }> {
  const commits = await call<GitHubCommit[]>(`/repos/${repo}/commits`, {
    since: window.from.toISOString(),
    until: window.to.toISOString(),
    per_page: String(PER_PAGE),
  });

  const payloads: CommitPayload[] = [];

  for (const commit of commits) {
    // Imported and rewritten history yields commits with no author block at all. Such a commit
    // cannot be placed on a timeline, and one of them must not cost the investigation every
    // deployment and pull request this collector had already found.
    const committedAt = isoOrUndefined(commit.commit.author?.date);
    if (committedAt === undefined) continue;

    payloads.push({
      repo,
      sha: commit.sha,
      message: subjectLineOf(commit.commit.message),
      author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
      committedAt,
      ...(commit.html_url === undefined ? {} : { url: commit.html_url }),
    });
  }

  return { evidence: payloads.map((payload) => draft(commitKind, payload)), payloads };
}

/**
 * The first line of a commit message, bounded.
 *
 * Bodies routinely contain stack traces, co-author blocks and pasted configuration, all of which
 * would be forwarded verbatim to a third-party model for no investigative gain.
 */
function subjectLineOf(message: string): string {
  const subject = message.split('\n')[0]?.trim() ?? '';
  return subject.length > 0 ? subject.slice(0, 500) : '(no commit message)';
}

/** `acme/payments-api` → `payments-api`, which is what the rest of the evidence calls it. */
function serviceNameOf(repo: string): string {
  return repo.split('/').at(-1) ?? repo;
}

/**
 * Normalises a timestamp GitHub has already been shown to parse.
 *
 * Only safe downstream of {@link within}, which rejects an unparseable date by comparing NaN.
 * Anywhere else, use {@link isoOrUndefined} — `new Date('').toISOString()` throws, and a throw
 * here costs the whole repository's evidence.
 */
function isoOf(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

function isoOrUndefined(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  const at = new Date(timestamp);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

function within(timestamp: string, window: TimeWindow): boolean {
  const at = new Date(timestamp).getTime();
  return at >= window.from.getTime() && at <= window.to.getTime();
}

type Requester = <T>(path: string, query?: Record<string, string>) => Promise<T>;

function requester(options: GitHubCollectorOptions): Requester {
  const baseUrl = options.baseUrl ?? GITHUB_API;
  const call = options.fetch ?? fetch;

  return async <T>(path: string, query: Record<string, string> = {}): Promise<T> => {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const response = await call(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token ?? ''}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'trace-incident-investigator',
      },
    });

    if (!response.ok) {
      // The status is the actionable part: 401 means fix the token, 403 with no remaining quota
      // means wait. This message becomes the gap text an on-call engineer reads.
      const rateLimited = response.headers.get('x-ratelimit-remaining') === '0';
      throw new Error(
        `GitHub returned ${response.status} for ${path}` +
          (rateLimited ? ' (rate limit exhausted)' : ''),
      );
    }

    return (await response.json()) as T;
  };
}
