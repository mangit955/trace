import { beforeEach, describe, expect, test } from 'bun:test';
import { INC_481 } from '@trace/collectors/fixtures';
import { type AlertIngress, receiveAlert } from './alert-ingress.ts';
import { buildDeps } from './wiring.ts';

const payload = {
  system: 'pagerduty',
  id: 'INC-481',
  summary: 'Elevated 5xx rate on payments-api',
};

function ingress(
  recipients: readonly string[],
): AlertIngress & { paged: string[]; pagedText: string[] } {
  const paged: string[] = [];
  const pagedText: string[] = [];

  return {
    paged,
    pagedText,
    agent: buildDeps({}),
    recipients,
    alreadyNotified: new Set<string>(),
    outbound: {
      connectionId: 'conn-1',
      client: {
        initiate: async (_connectionId: string, recipient: string, text: string) => {
          paged.push(recipient);
          pagedText.push(text);
        },
      },
    },
  };
}

let onCall: ReturnType<typeof ingress>;

beforeEach(() => {
  onCall = ingress(['ops@acme.com']);
});

describe('receiving an alert', () => {
  test('reconstructs the incident before saying anything to anyone', async () => {
    // The point of paging proactively is arriving with the answer already in hand.
    const result = await receiveAlert(onCall, payload);

    expect(result.investigated).toBe(true);
    const investigation = await onCall.agent.store.investigations.findByExternalRef(
      onCall.agent.tenant,
      INC_481.externalRef,
    );
    expect(investigation?.status).toBe('ready');
  });

  test('pages the operators on the allowlist', async () => {
    await receiveAlert(onCall, payload);

    expect(onCall.paged).toEqual(['ops@acme.com']);
  });

  test('pages with the finding, not just a notification', async () => {
    // The entire value of speaking first is arriving with the reconstruction already done. A page
    // that only says "something broke, ask me" is worth less than the alert that triggered it.
    await receiveAlert(onCall, payload);

    expect(onCall.pagedText[0]).toContain('REDIS_POOL_MAX');
    expect(onCall.pagedText[0]).toMatch(/9\d%/);
  });

  test('does not claim to still be working once it has finished', async () => {
    await receiveAlert(onCall, payload);

    expect(onCall.pagedText[0]).not.toMatch(/I am reconstructing/i);
  });

  test('pages nobody when no allowlist is configured', async () => {
    // Invariant 7, at the only place in Trace that can start a conversation.
    const silent = ingress([]);

    const result = await receiveAlert(silent, payload);

    expect(silent.paged).toEqual([]);
    expect(result.notified).toBe(0);
  });

  test('still investigates when there is nobody to page', async () => {
    // The reconstruction is useful the moment an engineer asks, even if Trace never spoke first.
    const silent = ingress([]);

    expect((await receiveAlert(silent, payload)).investigated).toBe(true);
  });

  test('pages once however many times the webhook is redelivered', async () => {
    // PagerDuty retries. Three identical pages at 3am would be worse than none.
    await receiveAlert(onCall, payload);
    await receiveAlert(onCall, payload);
    await receiveAlert(onCall, payload);

    expect(onCall.paged).toEqual(['ops@acme.com']);
  });

  test('refuses a payload that is not an alert, without investigating', async () => {
    expect(receiveAlert(onCall, { id: 'INC-481' })).rejects.toThrow(/alert/i);
    expect(onCall.paged).toEqual([]);
  });

  test('sends nothing at all when no channel is connected to send on', async () => {
    // Without a connection there is no way to initiate, and inventing one would be worse.
    const noChannel: AlertIngress = {
      agent: buildDeps({}),
      recipients: ['ops@acme.com'],
      alreadyNotified: new Set<string>(),
    };

    expect((await receiveAlert(noChannel, payload)).notified).toBe(0);
  });
});

describe('paging when reasoning failed', () => {
  test('does not promise a reconstruction that has already finished', async () => {
    // With no leading hypothesis the page used to fall back to "I am reconstructing what happened
    // now." That is false the moment reasoning fails rather than stalls: the reconstruction is
    // done, and someone woken at 3am would sit waiting for a follow-up that never arrives.
    const failing = ingress(['ops@acme.com']);
    failing.agent = {
      ...failing.agent,
      reasoner: {
        name: 'failing',
        model: 'failing-1',
        reason: async () => {
          throw new Error('429 quota exceeded');
        },
      },
    };

    await receiveAlert(failing, payload);

    expect(failing.paged).toEqual(['ops@acme.com']);
    expect(failing.pagedText[0]).not.toContain('reconstructing what happened now');
    // It points at the thing that *is* available, which is the timeline.
    expect(failing.pagedText[0]).toContain('could not reach a conclusion');
    expect(failing.pagedText[0]).toMatch(/\d+ events/);
  });
});
