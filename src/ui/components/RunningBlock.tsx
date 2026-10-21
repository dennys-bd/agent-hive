import type { ReactNode } from 'react';
import { activityOf } from '../../activities';
import { stageChannel } from '../../console';
import { stageOf } from '../../tasks';
import type { Activity, State, Task } from '../../types';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useOpenStageOutput } from '@/hooks/use-console';
import { useTick } from '@/hooks/use-tick';
import { t, tPlural } from '@/i18n';
import { ciLines, commandLines, evaluateLines, lineDuration, type RunningLine, type RunningMark, silence } from '@/lib/running-lines';
import { stageStopPath } from '@/lib/stage-stop';
import { viaTries } from '@/lib/tries';

// The details panel's block while a stage runs with no agent (#914): a wait for CI, a commands stage or an evaluation (#877), one line per check, command or reviewer with its
// time, the loop the task came through, a silent command's line, ver saída and parar. DetailPanel shows it in place of the status box.

const MUTED = 'text-muted-foreground';
const GLYPH: Record<RunningMark, ReactNode> = { done: '✓', failed: '✕', running: <Spinner />, skipped: '', queued: '' };
// Colour only for status: a failure destructive, the running line working; a queued or skipped line is muted whole
const GLYPH_TONE: Record<RunningMark, string> = { done: '', failed: 'text-destructive', running: 'text-working', skipped: '', queued: '' };
const isQuiet = (mark: RunningMark): boolean => mark === 'queued' || mark === 'skipped';

function Line({ line, now }: { line: RunningLine; now: number }) {
  const time = lineDuration(line, now);
  return (
    <li className={`flex items-center gap-2 ${isQuiet(line.mark) ? MUTED : ''}`}>
      <span aria-hidden="true" className={`w-3 shrink-0 text-center ${GLYPH_TONE[line.mark]}`}>{GLYPH[line.mark]}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{line.name}</span>
      {line.mark === 'skipped' && <span>{t('running.skipped')}</span>}
      {time !== undefined && <span className={`tabular-nums ${MUTED}`}>{time}</span>}
    </li>
  );
}

interface Shown { title: string; stage: string; lines: RunningLine[]; silent?: string }

// What the block shows: a commands stage's commands with a silent command's line, or a wait's checks; nothing while neither is in flight
function shownOf(live: Activity | undefined, state: State, now: number): Shown | undefined {
  const run = live?.commands;
  if (run !== undefined) {
    const names = stageOf(state.stages, run.stage)?.commands ?? [];
    const minutes = silence(run, now);
    const silent = minutes === undefined ? {} : { silent: t('running.silent', { n: minutes, name: names[run.at] ?? '' }) };
    return { title: t('running.commands'), stage: run.stage, lines: commandLines(run, names), ...silent };
  }
  const judged = live?.evaluate;
  if (judged !== undefined) { // #877: the reviewers then the judge; the card's own phase line is the title
    const stage = stageOf(state.stages, judged.stage);
    const n = stage?.reviewers?.length ?? 0;
    const title = judged.phase === 'judging' ? t('stageEvaluate.judging') : tPlural('stageEvaluate.reviewing', n, { n });
    return { title, stage: judged.stage, lines: evaluateLines(judged, stage, t('settings.stages.evaluate.judge')) };
  }
  const ci = live?.ci;
  return ci === undefined ? undefined : { title: t('running.ci'), stage: ci.stage, lines: ciLines(ci) };
}

// ver saída: a commands stage's execution in its console tab; an evaluation has none; a wait's running check on GitHub, the one that started first (the first spinner in
// the read's order), hidden with none running or no link. parar: the stage's own stop, the pty's or the wait's
function RunningActions({ task, live, lines }: { task: Task; live: Activity; lines: readonly RunningLine[] }) {
  const open = useOpenStageOutput();
  const run = live.commands;
  const checkUrl = run === undefined ? lines.find((line) => line.mark === 'running')?.url : undefined;
  const stop = (): void => {
    const path = stageStopPath(live);
    if (path !== undefined) void act(path);
  };
  return (
    <div className="flex gap-1.5">
      {run !== undefined && open !== undefined && (
        <Button type="button" size="xs" variant="outline" onClick={() => open(task.item.itemId, stageChannel(run.stage).id, run.runId)}>{t('running.output')}</Button>
      )}
      {checkUrl !== undefined && (
        <Button asChild size="xs" variant="outline"><a href={checkUrl} target="_blank" rel="noreferrer">{t('running.output')}</a></Button>
      )}
      <Button type="button" size="xs" variant="outline" onClick={stop}>{t('running.stop')}</Button>
    </div>
  );
}

/** The running block (#914): the header, a line per check or command, volta n/max, the silence line and the actions, in the working tone; a
 * silent command does not change the tone. Nothing while the task's live activity holds none of `ci`, `commands` and `evaluate`. */
export function RunningBlock({ task, state }: { task: Task; state: State }) {
  const live = activityOf(state, task.item.itemId);
  const now = Date.now();
  const shown = shownOf(live, state, now);
  useTick(shown?.lines.some((line) => line.mark === 'running') === true);
  if (live === undefined || shown === undefined) return null;
  const tries = viaTries(state, live);
  return (
    <section aria-label={shown.title} className="flex flex-col gap-2 rounded-lg border border-working bg-working/12 p-2.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-working">{shown.title}</span>
        <span className={`ml-auto ${MUTED}`}>{t('running.stage', { name: shown.stage })}</span>
      </div>
      {/* ponytail: two PRs reporting the same check name with no link share a key; React warns, nothing breaks */}
      <ul className="flex flex-col gap-1">{shown.lines.map((line) => <Line key={`${line.name}${line.url ?? ''}`} line={line} now={now} />)}</ul>
      {tries !== undefined && <p className={MUTED}>{t('running.loop', { n: tries.n, max: tries.max })}</p>}
      {shown.silent !== undefined && <p className={MUTED}>{shown.silent}</p>}
      <RunningActions task={task} live={live} lines={shown.lines} />
    </section>
  );
}
