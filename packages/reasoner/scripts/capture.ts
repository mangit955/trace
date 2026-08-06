import { collectEvidence } from '@trace/collectors';
import { fixtureCollectors, INC_481 } from '@trace/collectors/fixtures';
import {
  buildEvidenceGraph,
  createInvestigation,
  defaultWindowFor,
  EvidenceKindRegistry,
  missingInformationFrom,
  newId,
  OrgId,
  registerCoreKinds,
  serializeForReasoning,
  systemClock,
} from '@trace/domain';
import { geminiReasoner } from '../src/gemini.ts';
import { PROMPT_VERSION } from '../src/prompt.ts';
import { recordedReasoner } from '../src/recorded.ts';
import { reasonAboutInvestigation } from '../src/report.ts';

/**
 * Captures a real Gemini response for the seeded incident, so the demo can replay genuine model
 * prose with no API key.
 *
 * Run with `bun run capture:reasoning` and `GEMINI_API_KEY` set (a `.env` file is picked up
 * automatically and is gitignored).
 *
 * Two things this script refuses to do. It will not write a recording whose citations do not
 * resolve against the seeded evidence graph — a bad capture would otherwise sit in the repo until
 * someone ran the demo. And it only ever sends the **synthetic** seeded incident: free-tier prompts
 * are used to improve Google's products, so real incident telemetry must never come near it.
 */

const OUTPUT = new URL('../src/recordings/inc-481.json', import.meta.url);

const apiKey = process.env['GEMINI_API_KEY'];
if (!apiKey) {
  console.error(
    'GEMINI_API_KEY is not set.\n' +
      'Add it to .env (gitignored) or export it, then re-run: bun run capture:reasoning',
  );
  process.exit(1);
}

const registry = new EvidenceKindRegistry();
registerCoreKinds(registry);

const investigation = createInvestigation({
  orgId: newId(OrgId),
  externalRef: INC_481.externalRef,
  window: defaultWindowFor(INC_481.alertAt),
  now: INC_481.alertAt,
});

const collected = await collectEvidence({
  collectors: fixtureCollectors(INC_481),
  investigation,
  registry,
  clock: systemClock,
});

const graph = buildEvidenceGraph({
  investigationId: investigation.id,
  nodes: collected.nodes,
  edges: collected.edges,
});

const model = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';
const reasoner = geminiReasoner({ apiKey, model });

console.log(
  `Reasoning about ${INC_481.externalRef.id} with ${model} over ${graph.nodes.length} pieces of evidence…`,
);

const response = await reasoner.reason({
  investigation,
  evidence: serializeForReasoning(graph, registry),
  gaps: missingInformationFrom(collected.runs),
});

const recording = {
  externalId: INC_481.externalRef.id,
  model,
  promptVersion: PROMPT_VERSION,
  capturedAt: new Date().toISOString(),
  response,
};

// Replay it immediately through the real report path. If a citation does not resolve, this throws
// and nothing is written — the recording is only useful if it survives the same gate live
// reasoning has to pass.
const report = await reasonAboutInvestigation({
  investigation,
  graph,
  registry,
  runs: collected.runs,
  reasoner: recordedReasoner([recording]),
  now: new Date(),
});

await Bun.write(OUTPUT, `${JSON.stringify(recording, null, 2)}\n`);

console.log(`\nWrote ${OUTPUT.pathname}\n`);
console.log(report.summary);
for (const hypothesis of report.hypotheses) {
  const cited = hypothesis.citations.map((citation) => citation.label).join(', ');
  console.log(`\n  ${hypothesis.confidence.toFixed(2)}  ${hypothesis.statement}`);
  console.log(`        cites ${cited}`);
}
console.log('\nRead the above before committing it — it is what a reviewer will see.');
