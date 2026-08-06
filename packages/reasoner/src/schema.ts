/**
 * The response schema sent to Gemini.
 *
 * Hand-written rather than generated from the zod schema in `reasoner.ts`, and the duplication is
 * deliberate. Google's reference does not state which schema dialect `responseSchema` accepts, and
 * `z.toJSONSchema()` emits `$schema` and `additionalProperties`, which an OpenAPI-subset validator
 * may reject with a 400. So this stays to the constructs every version accepts — `type`,
 * `properties`, `items`, `required`, `enum`, `description` — and nothing else.
 *
 * The two schemas describe different contracts: this one asks for a shape, the zod one refuses to
 * trust that the shape came back. `schema.test.ts` keeps them in step.
 */
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'What happened, in two or three sentences, citing evidence labels in brackets like [E4].',
    },
    hypotheses: {
      type: 'array',
      description: 'Possible explanations, most likely first.',
      items: {
        type: 'object',
        properties: {
          statement: {
            type: 'string',
            description: 'One causal claim, stated plainly.',
          },
          confidence: {
            type: 'number',
            description: 'Your confidence between 0 and 1. Never a percentage.',
          },
          citations: {
            type: 'array',
            description: 'The evidence for and against this claim. At least one must support it.',
            items: {
              type: 'object',
              properties: {
                label: {
                  type: 'string',
                  description: 'An evidence label exactly as shown, such as E4.',
                },
                stance: { type: 'string', enum: ['supports', 'contradicts'] },
              },
              required: ['label', 'stance'],
            },
          },
        },
        required: ['statement', 'confidence', 'citations'],
      },
    },
    suggestedQuestions: {
      type: 'array',
      description: 'What an on-call engineer should ask next.',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'hypotheses', 'suggestedQuestions'],
} as const;
