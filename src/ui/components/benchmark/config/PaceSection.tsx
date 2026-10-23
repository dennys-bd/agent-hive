import type { ReactNode } from 'react';
import { experimentTokens, highestPercent } from '../../../../benchmark/cap.js';
import type { BenchPace, Experiment, PlanReadings } from '../../../../types.js';
import { type DurationFields, durationFields, durationMs, durationText, tokenText } from '@/components/benchmark/config/config-lib';
import { DurationField, EditButton, EditFoot, Field, FieldError, Pill, Row, Section, type SectionEdit, useDraft, useSave } from '@/components/benchmark/config/Section';
import { type MessageKey, t } from '@/i18n';

interface PaceProps { experiment: Experiment; edit: SectionEdit; rateLimits?: PlanReadings }
interface PaceDraft { pairs: string; until: string; timeout: DurationFields; workersPerArm: string; tokens: string; planPercent: string }
type PaceField = 'pairs' | 'timeout' | 'workersPerArm' | 'tokens' | 'planPercent';

const MAX_PERCENT = 100;
const textOf = (n: number | undefined): string => (n === undefined ? '' : String(n));
const isPositive = (s: string): boolean => /^\d+$/.test(s.trim()) && Number(s) >= 1;
const isPercent = (s: string): boolean => /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) <= MAX_PERCENT;
const isEmpty = (s: string): boolean => s.trim() === '';

const draftOf = (pace: BenchPace): PaceDraft => ({
  pairs: String(pace.pairs), until: pace.until ?? '', timeout: durationFields(pace.runTimeoutMs), workersPerArm: String(pace.workersPerArm),
  tokens: textOf(pace.cap.tokens), planPercent: textOf(pace.cap.planPercent),
});

// The route's PACE, mirrored: whole numbers ≥ 1, a timeout above 0, an optional token cap, an optional percent 0–100
function errorsOf(d: PaceDraft): Partial<Record<PaceField, MessageKey>> {
  const timeout = durationMs(d.timeout);
  const checks: [PaceField, boolean, MessageKey][] = [
    ['pairs', isPositive(d.pairs), 'benchmark.config.error.positive'],
    ['timeout', timeout !== undefined && !Number.isNaN(timeout), 'benchmark.config.error.duration'],
    ['workersPerArm', isPositive(d.workersPerArm), 'benchmark.config.error.positive'],
    ['tokens', isEmpty(d.tokens) || isPositive(d.tokens), 'benchmark.config.error.positive'],
    ['planPercent', isEmpty(d.planPercent) || isPercent(d.planPercent), 'benchmark.config.error.percent'],
  ];
  return Object.fromEntries(checks.filter(([, ok]) => !ok).map(([field, , key]) => [field, key]));
}

const paceOf = (d: PaceDraft): BenchPace => ({
  pairs: Number(d.pairs), ...(d.until === '' ? {} : { until: d.until }), runTimeoutMs: durationMs(d.timeout) ?? 0, workersPerArm: Number(d.workersPerArm),
  cap: { ...(isEmpty(d.tokens) ? {} : { tokens: Number(d.tokens) }), ...(isEmpty(d.planPercent) ? {} : { planPercent: Number(d.planPercent) }) },
});

/** The cap row's side (#463): the experiment's tokens and the highest plan window, the numbers the scheduler stops on (cap.ts). */
export function spendText(experiment: Experiment, rateLimits?: PlanReadings): string {
  const percent = highestPercent(rateLimits);
  return t('benchmark.config.pace.now', { tokens: tokenText(experimentTokens(experiment)), percent: percent === undefined ? '—' : `${Math.round(percent)}%` });
}

function capPills({ tokens, planPercent }: BenchPace['cap']): ReactNode {
  if (tokens === undefined && planPercent === undefined) return <Pill>{t('benchmark.config.off')}</Pill>;
  return (
    <>
      {tokens !== undefined && <Pill>{t('benchmark.config.pace.capTokens', { n: tokenText(tokens) })}</Pill>}
      {planPercent !== undefined && <Pill>{t(tokens === undefined ? 'benchmark.config.pace.capPlan' : 'benchmark.config.pace.capOrPlan', { n: planPercent })}</Pill>}
    </>
  );
}

const L = {
  pairs: (): string => t('benchmark.config.pace.pairs'), until: (): string => t('benchmark.config.pace.until'), timeout: (): string => t('benchmark.config.pace.timeout'),
  workers: (): string => t('benchmark.config.pace.workers'), cap: (): string => t('benchmark.config.pace.cap'),
};
const head = (): { title: string; sub: string } => ({ title: t('benchmark.config.pace.title'), sub: t('benchmark.config.pace.sub') });

function PaceForm({ experiment, edit }: PaceProps) {
  const [draft, setDraft] = useDraft(() => draftOf(experiment.pace), edit);
  const { isSaving, save } = useSave(experiment.id, edit);
  const errors = errorsOf(draft);
  const error = (field: PaceField): string | undefined => { const key = errors[field]; return key === undefined ? undefined : t(key); };
  const set = (patch: Partial<PaceDraft>): void => setDraft({ ...draft, ...patch });
  const timeoutError = error('timeout');
  return (
    <Section {...head()} foot={<EditFoot edit={edit} isValid={Object.keys(errors).length === 0} isSaving={isSaving} onSave={() => void save('pace', paceOf(draft))} />}>
      <Row label={L.pairs()} hint={t('benchmark.config.pace.pairs.hint')}><Field label={L.pairs()} value={draft.pairs} onChange={(pairs) => set({ pairs })} error={error('pairs')} /></Row>
      <Row label={L.until()} hint={t('benchmark.config.pace.until.hint')}><Field type="time" label={L.until()} value={draft.until} onChange={(until) => set({ until })} className="w-28" /></Row>
      <Row label={L.timeout()}><DurationField label={L.timeout()} value={draft.timeout} onChange={(timeout) => set({ timeout })} />{timeoutError !== undefined && <FieldError>{timeoutError}</FieldError>}</Row>
      <Row label={L.workers()} hint={t('benchmark.config.pace.workers.hint')}><Field label={L.workers()} value={draft.workersPerArm} onChange={(workersPerArm) => set({ workersPerArm })} error={error('workersPerArm')} /></Row>
      <Row label={L.cap()} hint={t('benchmark.config.pace.cap.hint')}>
        <Field label={t('benchmark.config.pace.tokensField')} value={draft.tokens} onChange={(tokens) => set({ tokens })} error={error('tokens')} className="w-28" />
        <Field label={t('benchmark.config.pace.planField')} value={draft.planPercent} onChange={(planPercent) => set({ planPercent })} error={error('planPercent')} />
      </Row>
    </Section>
  );
}

/** ritmo (#463): pares, horário limite, timeout por run, workers por braço and the spend cap with what is spent now. */
export function PaceSection({ experiment, edit, rateLimits }: PaceProps) {
  if (edit.isOpen) return <PaceForm experiment={experiment} edit={edit} />;
  const { pace } = experiment;
  return (
    <Section {...head()} side={<EditButton edit={edit} />}>
      <Row label={L.pairs()} hint={t('benchmark.config.pace.pairs.hint')}><Pill>{pace.pairs}</Pill></Row>
      <Row label={L.until()} hint={t('benchmark.config.pace.until.hint')}><Pill>{pace.until ?? t('benchmark.config.pace.noUntil')}</Pill></Row>
      <Row label={L.timeout()}><Pill>{durationText(pace.runTimeoutMs)}</Pill></Row>
      <Row label={L.workers()} hint={t('benchmark.config.pace.workers.hint')}><Pill>{pace.workersPerArm}</Pill></Row>
      <Row label={L.cap()} hint={t('benchmark.config.pace.cap.hint')} side={spendText(experiment, rateLimits)}>{capPills(pace.cap)}</Row>
    </Section>
  );
}
