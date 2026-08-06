import { describe, expect, test } from 'bun:test';
import { CitationDraft, HypothesisDraft, ReasonedOutput } from './reasoner.ts';
import { GEMINI_RESPONSE_SCHEMA } from './schema.ts';

/**
 * The wire schema and the validation schema are written separately on purpose, so this is what
 * stops them drifting apart. A field added to one and not the other means either the model is never
 * asked for something we require, or it returns something we silently strip.
 */
describe('the Gemini response schema', () => {
  test('asks for exactly the fields the parser requires', () => {
    expect([...GEMINI_RESPONSE_SCHEMA.required] as string[]).toEqual(
      Object.keys(ReasonedOutput.shape),
    );
  });

  test('describes a hypothesis with the fields the parser requires', () => {
    const hypothesis = GEMINI_RESPONSE_SCHEMA.properties.hypotheses.items;

    expect([...hypothesis.required] as string[]).toEqual(Object.keys(HypothesisDraft.shape));
  });

  test('describes a citation with the fields the parser requires', () => {
    const citation = GEMINI_RESPONSE_SCHEMA.properties.hypotheses.items.properties.citations.items;

    expect([...citation.required] as string[]).toEqual(Object.keys(CitationDraft.shape));
  });

  test('offers only the stances the parser accepts', () => {
    const stance =
      GEMINI_RESPONSE_SCHEMA.properties.hypotheses.items.properties.citations.items.properties
        .stance;

    expect([...stance.enum] as string[]).toEqual(CitationDraft.shape.stance.options);
  });

  test('uses no construct an OpenAPI-subset validator might reject', () => {
    // The docs do not state the dialect accepted, so the schema stays to constructs every
    // version accepts. $schema and additionalProperties are what z.toJSONSchema would add.
    const serialized = JSON.stringify(GEMINI_RESPONSE_SCHEMA);

    expect(serialized).not.toContain('$schema');
    expect(serialized).not.toContain('additionalProperties');
  });
});
