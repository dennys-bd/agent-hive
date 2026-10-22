import { testerPrompt as walkPrompt } from '../../src/benchmark/browser.js';
import type { Artboard, Scenario } from './seed.js';

const renderArtboards = (artboards: readonly Artboard[]): string => artboards.map((a) => `- ${a.id}: ${a.title}${a.live ? ' (live: skip it)' : ''}`).join('\n');

/** The harness's tester prompt (#105): the dashboard, its sign-in and its artboards around the moved prompt; no secret here. */
export function testerPrompt(o: { url: string; handoff: string; scenarios: readonly Scenario[]; artboards: readonly Artboard[] }): string {
  const intro = `This is the dashboard of a desktop app: the browser is already signed in to it. Do not click a control that approves a stage, stops a session, resumes or starts a run unless a scenario tells you to.

No agent is running, so a screen that needs one (an agent working or waiting, a live terminal, an agent's / commands) cannot be shown.

First, for each artboard below, reach its screen the way the handoff says and take one screenshot named screen-<artboard>.png (screen-4a.png for 4a). Skip the artboards marked live and any you cannot reach, and say which in the notes of S1:
${renderArtboards(o.artboards)}

The handoff:

${o.handoff}`;
  return walkPrompt({ url: o.url, scenarios: o.scenarios, intro });
}

// Every word here passes blind.ts's ARM_LEAK
const HEAD = `You are judging one implementation of the Monitor View design handoff in the Agent Hive repository, a TypeScript desktop app, built as eight deliveries. Everything you may read is in the current folder: read it with the Read and Glob tools and nothing else.

- handoff/<artboard>-<name>.png: the design, one screen per artboard (4a to 4k).
- docs/spec-<n>.md and docs/plan-<n>.md: the specs and plans written for it.
- diff.patch: every change, against the commit it started from.
- metrics.json: tokens, time, outcome and restarts.

Parts of the design that need a live agent session (an agent working or waiting for an answer, a live terminal, an agent's / commands) cannot be shown on this run: score those parts from the code only.`;
const BOOTED = `- run/screen-<artboard>.png: the same screens as this implementation shows them, where reachable; run/S<n>-<step>.png and run/shot-<n>.png: a screenshot per scenario step.
- clicks.json: the click scenarios a tester walked, each passed or failed, with notes.`;
const NOT_BOOTED = 'This implementation did not boot: its build or its daemon failed, so there are no run screenshots and no clicks. Answer "score": null for fidelity and behaviour, with the reason "did not boot".';
const RUBRIC = `Score each criterion from 1 (poor) to 10 (excellent), with a reason of one or two sentences:
- fidelity: the run screens next to the handoff screens: layout, spacing, copy, states.
- behaviour: the click results; a failed scenario weighs more than a cosmetic gap.
- code: the diff: correctness, structure, consistency with the code around it, no dead code.
- specAndPlan: whether the specs and plans are complete and match the handoff, and whether the code follows them.
- tests: whether the tests in the diff cover the behaviour and would catch a regression.`;
const ANSWER = `Your final message is only this JSON object:
{"fidelity": {"score": 7, "reason": "..."}, "behaviour": {"score": 7, "reason": "..."}, "code": {"score": 7, "reason": "..."}, "specAndPlan": {"score": 7, "reason": "..."}, "tests": {"score": 7, "reason": "..."}}`;

export const judgePrompt = ({ booted }: { booted: boolean }): string => [HEAD, booted ? BOOTED : NOT_BOOTED, RUBRIC, ANSWER].join('\n\n');
