import { describe, expect, test } from 'bun:test';
import { INC_481 } from '@trace/collectors/fixtures';
import { notifyOnCall, type OutboundAttempt, recipientsFrom } from './alerts.ts';

function recorder() {
  const sent: OutboundAttempt[] = [];
  return {
    sent,
    initiate: async (connectionId: string, recipient: string, text: string) => {
      sent.push({ connectionId, recipient, text });
    },
  };
}

const alert = { externalRef: INC_481.externalRef, summary: 'Elevated 5xx on payments-api' };

describe('recipientsFrom', () => {
  test('reads a comma-separated allowlist', () => {
    expect(recipientsFrom('ops@acme.com, sre@acme.com')).toEqual(['ops@acme.com', 'sre@acme.com']);
  });

  test('treats an unset variable as nobody', () => {
    // The default must be silence. An agent that messages people because a variable was forgotten
    // is a spam incident of its own.
    expect(recipientsFrom(undefined)).toEqual([]);
    expect(recipientsFrom('')).toEqual([]);
    expect(recipientsFrom('   ,  ,')).toEqual([]);
  });
});

describe('notifying on-call', () => {
  test('messages every operator on the allowlist', async () => {
    const caspian = recorder();

    await notifyOnCall({
      client: caspian,
      connectionId: 'conn-1',
      recipients: ['ops@acme.com', 'sre@acme.com'],
      alert,
      alreadyNotified: new Set(),
    });

    expect(caspian.sent.map((s) => s.recipient)).toEqual(['ops@acme.com', 'sre@acme.com']);
  });

  test('sends nothing at all when the allowlist is empty', async () => {
    // Invariant 7. This is the test that has to hold even if every other one breaks.
    const caspian = recorder();

    await notifyOnCall({
      client: caspian,
      connectionId: 'conn-1',
      recipients: [],
      alert,
      alreadyNotified: new Set(),
    });

    expect(caspian.sent).toEqual([]);
  });

  test('messages once per incident, however many times the webhook fires', async () => {
    // PagerDuty retries deliveries. Three identical pages at 3am would be worse than none.
    const caspian = recorder();
    const alreadyNotified = new Set<string>();

    for (let delivery = 0; delivery < 3; delivery++) {
      await notifyOnCall({
        client: caspian,
        connectionId: 'conn-1',
        recipients: ['ops@acme.com'],
        alert,
        alreadyNotified,
      });
    }

    expect(caspian.sent).toHaveLength(1);
  });

  test('names the incident and what is known so far', async () => {
    const caspian = recorder();

    await notifyOnCall({
      client: caspian,
      connectionId: 'conn-1',
      recipients: ['ops@acme.com'],
      alert,
      alreadyNotified: new Set(),
    });

    expect(caspian.sent[0]?.text).toContain('INC-481');
    expect(caspian.sent[0]?.text).toContain('Elevated 5xx on payments-api');
  });

  test('keeps going when one recipient fails', async () => {
    // One bad address must not silence the rest of the on-call rotation.
    const sent: string[] = [];
    const flaky = {
      initiate: async (_c: string, recipient: string) => {
        if (recipient === 'broken@acme.com') throw new Error('unknown recipient');
        sent.push(recipient);
      },
    };

    await notifyOnCall({
      client: flaky,
      connectionId: 'conn-1',
      recipients: ['broken@acme.com', 'ops@acme.com'],
      alert,
      alreadyNotified: new Set(),
    });

    expect(sent).toEqual(['ops@acme.com']);
  });
});
