import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Arm, BenchIsolation, Experiment, IsolationRow } from '../../../../types.js';
import { durationText, linesOf, mapRow, PERMISSION_MODES, resolve, riskyArms, toggleScope } from '@/components/benchmark/config/config-lib';
import { type EditableKey, type IsolationDraft, isolationDraft, isolationErrors, isolationFrom, type LimitsDraft } from '@/components/benchmark/config/isolation-draft';
import { DurationField, EditButton, EditFoot, Field, FieldError, None, Pill, Row, Section, type SectionEdit, useDraft, useSave } from '@/components/benchmark/config/Section';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

interface IsolationProps { experiment: Experiment; edit: SectionEdit }
const ORDER = ['environment', 'network', 'permissionMode', 'allowedTools', 'deniedTools', 'limits', 'env', 'betweenRounds'] as const;
type IsoKey = (typeof ORDER)[number];
type TextKey = 'network' | 'allowedTools' | 'deniedTools' | 'env';
const label = (k: IsoKey): string => t(`benchmark.config.iso.${k}`);
const hint = (k: IsoKey): string => t(`benchmark.config.iso.${k}.hint`);
const head = (): { title: string; sub: string } => ({ title: t('benchmark.config.iso.title'), sub: t('benchmark.config.iso.sub') });

const limitTexts = (l: { turns?: number; ms?: number }): string[] => [
  ...(l.turns === undefined ? [] : [t('benchmark.config.iso.turns', { n: l.turns })]), ...(l.ms === undefined ? [] : [durationText(l.ms)]),
];
// Every row as pill texts, so one reader draws them all; ambiente and entre rodadas allow one value each (root design: local only)
const readRows = (iso: BenchIsolation): Record<IsoKey, IsolationRow<string[]>> => ({
  environment: mapRow(iso.environment, () => ['local']), network: iso.network, permissionMode: mapRow(iso.permissionMode, (mode) => [mode]),
  allowedTools: iso.allowedTools, deniedTools: iso.deniedTools, limits: mapRow(iso.limits, limitTexts),
  env: mapRow(iso.env, (env) => Object.entries(env).map(([name, value]) => `${name}=${value}`)),
  betweenRounds: mapRow(iso.betweenRounds, () => [t('benchmark.config.iso.freshWorktree')]),
});
const isFixed = (k: IsoKey): boolean => k === 'environment' || k === 'betweenRounds';

function RiskLine({ arms }: { arms: readonly Arm[] }) {
  if (arms.length === 0) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-waiting" />{t('benchmark.config.iso.risk', { arms: arms.map((a) => a.letter).join(', ') })}
    </span>
  );
}

const scopeText = (varies: boolean): string => t(varies ? 'benchmark.config.iso.varies' : 'benchmark.config.iso.allArms');

function ReadRow({ k, row, arms, risky }: { k: IsoKey; row: IsolationRow<string[]>; arms: readonly Arm[]; risky: readonly Arm[] }) {
  const isRisky = (armId?: string): boolean => k === 'permissionMode' && (armId === undefined ? risky.length > 0 : risky.some((a) => a.id === armId));
  // biome-ignore lint/suspicious/noArrayIndexKey: a list row can repeat an entry, so the value alone is no key
  const shared = row.all.length === 0 ? <None /> : row.all.map((value, i) => <Pill key={`${i}:${value}`} isMono isRisk={isRisky()}>{value}</Pill>);
  const perArm = arms.map((arm) => <Pill key={arm.id} isMono arm={arm.letter} isRisk={isRisky(arm.id)}>{resolve(row, arm.id).join(', ') || '—'}</Pill>);
  return (
    <Row label={label(k)} hint={hint(k)} isIsolation side={isFixed(k) ? undefined : scopeText(row.perArm !== undefined)}>
      {row.perArm === undefined ? shared : perArm}
      {k === 'permissionMode' && <RiskLine arms={risky} />}
    </Row>
  );
}

function ScopeMenu({ name, varies, onPick }: { name: string; varies: boolean; onPick(varies: boolean): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="xs" aria-label={t('benchmark.config.iso.scope', { row: name })} className={varies ? 'text-foreground' : 'text-muted-foreground'}>
          {scopeText(varies)}<ChevronDownIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onPick(false)}>{scopeText(false)}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick(true)}>{scopeText(true)}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Editor<T> = (value: T, onValue: (value: T) => void, name: string, armId?: string) => ReactNode;
interface EditRowProps<T> { k: EditableKey; row: IsolationRow<T>; arms: readonly Arm[]; editor: Editor<T>; error?: string; extra?: ReactNode; onChange(row: IsolationRow<T>): void }

// A row of the form: its scope menu, then one editor for every arm or one per arm, each prefixed by the arm's letter
function EditRow<T>({ k, row, arms, editor, error, extra, onChange }: EditRowProps<T>) {
  const name = label(k);
  const varies = row.perArm !== undefined;
  const pick = (toVary: boolean): void => { if (toVary !== varies) onChange(toggleScope(row, arms.map((a) => a.id))); };
  const setArm = (armId: string) => (value: T): void => onChange({ ...row, perArm: { ...row.perArm, [armId]: value } });
  const perArm = arms.map((arm) => (
    <span key={arm.id} className="flex items-center gap-1">
      <b className="font-semibold text-muted-foreground text-xs">{arm.letter}</b>{editor(resolve(row, arm.id), setArm(arm.id), t('benchmark.config.iso.ofArm', { row: name, arm: arm.letter }), arm.id)}
    </span>
  ));
  return (
    <Row label={name} hint={hint(k)} isIsolation side={<ScopeMenu name={name} varies={varies} onPick={pick} />}>
      {varies ? perArm : editor(row.all, (value) => onChange({ ...row, all: value }), name)}
      {extra}
      {error !== undefined && <FieldError>{error}</FieldError>}
    </Row>
  );
}

const textEditor: Editor<string> = (value, onValue, name) => (
  <Textarea aria-label={name} rows={2} spellCheck={false} placeholder={t('benchmark.config.iso.perLine')} value={value} onChange={(e) => onValue(e.target.value)} className="min-h-0 w-56 font-mono text-xs" />
);

const limitsEditor: Editor<LimitsDraft> = (value, onValue, name) => (
  <span className="flex items-center gap-2">
    <Field label={t('benchmark.config.fieldOf', { field: t('benchmark.config.iso.turnsField'), row: name })} value={value.turns} onChange={(turns) => onValue({ ...value, turns })} />
    <DurationField label={name} value={value.time} onChange={(time) => onValue({ ...value, time })} />
  </span>
);

function modeEditor(risky: readonly Arm[]): Editor<string> {
  return (value, onValue, name, armId) => {
    const isRisk = risky.some((a) => armId === undefined || a.id === armId);
    return (
      <Select value={value} onValueChange={onValue}>
        <SelectTrigger aria-label={name} className={`h-7 font-mono text-xs ${isRisk ? 'border-waiting' : ''}`}><SelectValue /></SelectTrigger>
        <SelectContent>{[...new Set([...PERMISSION_MODES, value])].map((mode) => <SelectItem key={mode} value={mode} className="font-mono text-xs">{mode}</SelectItem>)}</SelectContent>
      </Select>
    );
  };
}

function IsolationForm({ experiment, edit }: IsolationProps) {
  const [draft, setDraft] = useDraft(() => isolationDraft(experiment.isolation), edit);
  const { isSaving, save } = useSave(experiment.id, edit);
  const { arms } = experiment;
  const errors = isolationErrors(draft);
  const rows = readRows(experiment.isolation);
  const risky = riskyArms(arms, { permissionMode: draft.permissionMode, deniedTools: mapRow(draft.deniedTools, linesOf) }); // live, a warning only
  const setRow = <K extends EditableKey>(k: K, next: IsolationDraft[K]): void => setDraft({ ...draft, [k]: next });
  const errorOf = (k: EditableKey): string | undefined => { const key = errors[k]; return key === undefined ? undefined : t(key); };
  const text = (k: TextKey) => <EditRow k={k} row={draft[k]} arms={arms} editor={textEditor} error={errorOf(k)} onChange={(next) => setRow(k, next)} />;
  return (
    <Section {...head()} foot={<EditFoot edit={edit} isValid={Object.keys(errors).length === 0} isSaving={isSaving} onSave={() => void save('isolation', isolationFrom(draft, experiment.isolation))} />}>
      <ReadRow k="environment" row={rows.environment} arms={arms} risky={[]} />
      {text('network')}
      <EditRow k="permissionMode" row={draft.permissionMode} arms={arms} editor={modeEditor(risky)} extra={<RiskLine arms={risky} />} onChange={(next) => setRow('permissionMode', next)} />
      {text('allowedTools')}
      {text('deniedTools')}
      <EditRow k="limits" row={draft.limits} arms={arms} editor={limitsEditor} error={errorOf('limits')} onChange={(next) => setRow('limits', next)} />
      {text('env')}
      <ReadRow k="betweenRounds" row={rows.betweenRounds} arms={arms} risky={[]} />
    </Section>
  );
}

/** isolamento (#463): one row per BenchIsolation key, each for every arm or varying per arm, with the yellow warning on an arm that runs
 * bypassPermissions with nothing denied. */
export function IsolationSection({ experiment, edit }: IsolationProps) {
  if (edit.isOpen) return <IsolationForm experiment={experiment} edit={edit} />;
  const rows = readRows(experiment.isolation);
  const risky = riskyArms(experiment.arms, experiment.isolation);
  return (
    <Section {...head()} side={<EditButton edit={edit} />}>
      {ORDER.map((k) => <ReadRow key={k} k={k} row={rows[k]} arms={experiment.arms} risky={risky} />)}
    </Section>
  );
}
