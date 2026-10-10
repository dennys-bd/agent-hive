import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvaluateArgs, parseExperimentArgs } from '../../scripts/experiment/args.js';

test('parseExperimentArgs defaults to 20 h per run and the fable judge, and leaves the rest to the manifest (#105)', () => {
  assert.deepEqual(parseExperimentArgs([]), { runTimeoutMs: 72_000_000, judgeModel: 'claude-fable-5-1' });
});

test('parseExperimentArgs reads every flag (#105)', () => {
  assert.deepEqual(
    parseExperimentArgs(['--experiment', 'skills-x', '--runs', '2', '--until', '07:00', '--run-timeout', '90m', '--judge-model', 'sonnet', '--baseline', 'origin/main']),
    { experiment: 'skills-x', runs: 2, until: '07:00', baseline: 'origin/main', runTimeoutMs: 5_400_000, judgeModel: 'sonnet' },
  );
});

test('parseExperimentArgs refuses a bad count, model, deadline, timeout, id or flag before anything runs (#105)', () => {
  const bad: [string[], RegExp][] = [
    [['--runs', '0'], /--runs/], [['--runs', 'two'], /--runs/], [['--judge-model', '-x'], /--judge-model/], [['--until', '7:00'], /--until/],
    [['--experiment', '../x'], /--experiment/], [['--foo'], /Unknown option/], [['--run-timeout', '2d'], /--run-timeout/],
  ];
  for (const [argv, message] of bad) assert.throws(() => parseExperimentArgs(argv), message, argv.join(' '));
});

test('parseEvaluateArgs needs --experiment and takes one run id (#105)', () => {
  assert.deepEqual(parseEvaluateArgs(['--experiment', 'skills-x', '--run', 'b2']), { experiment: 'skills-x', run: 'b2', judgeModel: 'claude-fable-5-1' });
  assert.throws(() => parseEvaluateArgs([]), /--experiment is required/);
  assert.throws(() => parseEvaluateArgs(['--experiment', 'skills-x', '--run', 'c1']), /--run/);
});
