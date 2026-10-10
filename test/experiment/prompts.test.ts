import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARM_LEAK, hasTell } from '../../scripts/experiment/blind.js';
import { judgePrompt, testerPrompt } from '../../scripts/experiment/prompts.js';
import { CRITERIA } from '../../scripts/experiment/types.js';
import { SEED } from './fixtures.js';

test('testerPrompt gives the URL, the handoff, the artboards (a live one to skip) and every scenario, asks for JSON and forbids edits (#105)', () => {
  const prompt = testerPrompt({ url: 'http://127.0.0.1:4321/', handoff: '# Handoff: monitor', scenarios: SEED.scenarios, artboards: SEED.artboards });
  for (const part of ['http://127.0.0.1:4321/', '# Handoff: monitor', '- 4a: grid padrão', '- 4c: comandos do agente (live: skip it)', 'screen-<artboard>.png', '## S1 · Open the monitor', '"scenario"', 'Never edit']) {
    assert.ok(prompt.includes(part), part);
  }
});

test('judgePrompt names the five criteria, scores live-only parts from the code, nulls visual ones when not booted, never names an arm (#105)', () => {
  const booted = judgePrompt({ booted: true });
  const dead = judgePrompt({ booted: false });
  for (const prompt of [booted, dead]) {
    assert.ok(!ARM_LEAK.test(prompt), 'blind');
    assert.equal(hasTell(prompt), false);
    for (const c of CRITERIA) assert.ok(prompt.includes(`"${c}"`), c);
    assert.match(prompt, /live agent session.*from the code only/s);
  }
  assert.ok(booted.includes('clicks.json') && !booted.includes('did not boot'));
  assert.match(dead, /did not boot.*"score": null/s);
});
