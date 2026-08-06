import { describe, expect, test } from 'bun:test';
import { newId, OrgId } from '../ids.ts';
import {
  createInvestigation,
  DEFAULT_FORWARD_MINUTES,
  DEFAULT_LOOKBACK_MINUTES,
  defaultWindowFor,
  fail,
  IllegalTransitionError,
  isTerminal,
  transition,
} from './investigation.ts';

const orgId = newId(OrgId);
const externalRef = { system: 'pagerduty', id: 'INC-481' };
const firedAt = new Date('2026-08-06T10:16:00.000Z');
const window = {
  from: new Date('2026-08-06T09:16:00.000Z'),
  to: new Date('2026-08-06T10:31:00.000Z'),
};

function newInvestigation() {
  return createInvestigation({ orgId, externalRef, window, now: firedAt });
}

describe('creation', () => {
  test('starts pending, because no evidence has been collected yet', () => {
    expect(newInvestigation().status).toBe('pending');
  });

  test('assigns a distinct id per investigation', () => {
    expect(newInvestigation().id).not.toBe(newInvestigation().id);
  });

  test('records the external reference it mirrors', () => {
    // Trace does not own incident lifecycle; this is the key back to the system that does.
    expect(newInvestigation().externalRef).toEqual(externalRef);
  });

  test('stamps createdAt and updatedAt from the supplied clock', () => {
    const investigation = newInvestigation();
    expect(investigation.createdAt).toEqual(firedAt);
    expect(investigation.updatedAt).toEqual(firedAt);
  });

  test('rejects a window that ends before it starts', () => {
    const backwards = { from: window.to, to: window.from };
    expect(() =>
      createInvestigation({ orgId, externalRef, window: backwards, now: firedAt }),
    ).toThrow('window');
  });

  test('rejects a zero-length window', () => {
    const empty = { from: firedAt, to: firedAt };
    expect(() => createInvestigation({ orgId, externalRef, window: empty, now: firedAt })).toThrow(
      'window',
    );
  });
});

describe('the happy path', () => {
  test('advances pending → collecting → reasoning → ready', () => {
    const collecting = transition(newInvestigation(), 'collecting', firedAt);
    const reasoning = transition(collecting, 'reasoning', firedAt);
    const ready = transition(reasoning, 'ready', firedAt);

    expect([collecting.status, reasoning.status, ready.status]).toEqual([
      'collecting',
      'reasoning',
      'ready',
    ]);
  });

  test('advances updatedAt without touching createdAt', () => {
    const later = new Date('2026-08-06T10:20:00.000Z');
    const collecting = transition(newInvestigation(), 'collecting', later);

    expect(collecting.updatedAt).toEqual(later);
    expect(collecting.createdAt).toEqual(firedAt);
  });

  test('returns a new object rather than mutating the original', () => {
    const pending = newInvestigation();
    const collecting = transition(pending, 'collecting', firedAt);

    expect(pending.status).toBe('pending');
    expect(collecting).not.toBe(pending);
  });
});

describe('illegal transitions', () => {
  test.each([
    ['pending', 'reasoning'],
    ['pending', 'ready'],
    ['collecting', 'ready'],
    ['collecting', 'pending'],
    ['reasoning', 'collecting'],
  ] as const)('rejects %s → %s', (from, to) => {
    let investigation = newInvestigation();
    if (from !== 'pending') investigation = transition(investigation, 'collecting', firedAt);
    if (from === 'reasoning') investigation = transition(investigation, 'reasoning', firedAt);

    expect(() => transition(investigation, to, firedAt)).toThrow(IllegalTransitionError);
  });

  test('names both states in the error, so a bad transition is debuggable from the log alone', () => {
    expect(() => transition(newInvestigation(), 'ready', firedAt)).toThrow('pending');
  });
});

describe('failure', () => {
  test('can fail from any non-terminal state', () => {
    const collecting = transition(newInvestigation(), 'collecting', firedAt);
    expect(fail(collecting, 'collector timeout', firedAt).status).toBe('failed');
  });

  test('records why it failed', () => {
    expect(fail(newInvestigation(), 'no evidence sources configured', firedAt).failureReason).toBe(
      'no evidence sources configured',
    );
  });

  test('rejects an empty reason, since an unexplained failure is not actionable', () => {
    expect(() => fail(newInvestigation(), '   ', firedAt)).toThrow('reason');
  });
});

describe('terminal states', () => {
  test.each(['ready', 'failed'] as const)('%s is terminal', (status) => {
    expect(isTerminal(status)).toBe(true);
  });

  test.each(['pending', 'collecting', 'reasoning'] as const)('%s is not terminal', (status) => {
    expect(isTerminal(status)).toBe(false);
  });

  test('a ready investigation cannot be reopened', () => {
    // Evidence is immutable and citations must stay stable, so re-investigating means creating a
    // new Investigation rather than mutating a finished one.
    let investigation = transition(newInvestigation(), 'collecting', firedAt);
    investigation = transition(investigation, 'reasoning', firedAt);
    investigation = transition(investigation, 'ready', firedAt);

    expect(() => transition(investigation, 'collecting', firedAt)).toThrow(IllegalTransitionError);
  });

  test('a failed investigation cannot be retried in place', () => {
    const failed = fail(newInvestigation(), 'collector timeout', firedAt);
    expect(() => transition(failed, 'collecting', firedAt)).toThrow(IllegalTransitionError);
  });
});

describe('defaultWindowFor', () => {
  test('looks back far enough to catch the change that caused the alert', () => {
    const { from } = defaultWindowFor(firedAt);
    const minutesBefore = (firedAt.getTime() - from.getTime()) / 60_000;
    expect(minutesBefore).toBe(DEFAULT_LOOKBACK_MINUTES);
  });

  test('extends past the alert to capture the blast radius', () => {
    const { to } = defaultWindowFor(firedAt);
    const minutesAfter = (to.getTime() - firedAt.getTime()) / 60_000;
    expect(minutesAfter).toBe(DEFAULT_FORWARD_MINUTES);
  });

  test('produces a window a new investigation accepts', () => {
    expect(() =>
      createInvestigation({ orgId, externalRef, window: defaultWindowFor(firedAt), now: firedAt }),
    ).not.toThrow();
  });
});
