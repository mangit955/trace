import { describe, expect, test } from 'bun:test';
import { parseIntent } from './intent.ts';

describe('parseIntent', () => {
  test('recognises an investigation request and extracts the incident id', () => {
    expect(parseIntent('investigate INC-481')).toEqual({
      kind: 'investigate',
      incidentId: 'INC-481',
    });
  });

  test('accepts the ways people actually type it', () => {
    // On-call engineers type in a hurry, on a phone, at 3am.
    for (const text of [
      'Investigate INC-481',
      '  investigate   inc-481  ',
      'investigate INC-481?',
      'look into INC-481',
      'what happened with INC-481',
      'INC-481',
    ]) {
      expect(parseIntent(text)).toEqual({ kind: 'investigate', incidentId: 'INC-481' });
    }
  });

  test('recognises a follow-up asking for reasoning', () => {
    for (const text of ['why', 'why?', 'Why?', 'but why', 'how come?']) {
      expect(parseIntent(text).kind).toBe('why');
    }
  });

  test('recognises a request to show a specific piece of evidence', () => {
    expect(parseIntent('show deploy')).toEqual({ kind: 'show', subject: 'deploy' });
    expect(parseIntent('show me the logs')).toEqual({ kind: 'show', subject: 'logs' });
  });

  test('recognises a request for help', () => {
    for (const text of ['help', 'HELP', '/help', 'what can you do?']) {
      expect(parseIntent(text).kind).toBe('help');
    }
  });

  test('treats anything else as a question to answer', () => {
    expect(parseIntent('was the redis pool ever raised back to 50?')).toEqual({
      kind: 'question',
      text: 'was the redis pool ever raised back to 50?',
    });
  });

  test('treats a message with no text at all as a request for help', () => {
    // Message.text is nullable in the SDK — a photo or a voice note must not crash the handler.
    expect(parseIntent(null).kind).toBe('help');
    expect(parseIntent('   ').kind).toBe('help');
  });

  test('does not mistake an incident id inside a question for an investigation request', () => {
    // "why did INC-481 happen" is a follow-up about an incident already under discussion, not a
    // request to start a second investigation of it.
    expect(parseIntent('why did INC-481 happen?').kind).toBe('why');
  });
});
