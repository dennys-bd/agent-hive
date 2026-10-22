import { LockIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import type { BenchScenario, BenchSeed, Experiment } from '../../../../types.js';
import { COMMIT_SHA, nextScenarioId, scenarioIdsValid, scenariosText } from '@/components/benchmark/config/config-lib';
import { refusalOf } from '@/components/benchmark/config/save-section';
import { EntryPill, SeedEntries } from '@/components/benchmark/config/SeedEntries';
import { EditButton, EditFoot, Field, FieldError, None, Note, Pill, Row, Section, type SectionEdit, useDraft, useSave } from '@/components/benchmark/config/Section';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { t } from '@/i18n';

interface SeedProps { experiment: Experiment; edit: SectionEdit }
type EntryList = 'reference' | 'files';
const HASH_CHARS = 6;
const COMMIT_CHARS = 7;
const L = {
  workspace: (): string => t('benchmark.config.seed.workspace'), commit: (): string => t('benchmark.config.seed.commit'),
  reference: (): string => t('benchmark.config.seed.reference'), sample: (): string => t('benchmark.config.seed.sample'), scenarios: (): string => t('benchmark.config.seed.scenarios'),
};

// The base branch is not in the UI's state (the plan's QUESTIONS): the commit reads alone, as the header's baseline does
const commitText = (seed: BenchSeed): string => seed.commit.slice(0, COMMIT_CHARS);

// The section's head: its sub line, the hash with the lock, and the note that a seed change makes a new experiment
function seedHead(experiment: Experiment) {
  return {
    title: t('benchmark.config.seed.title'), sub: t('benchmark.config.seed.sub'), note: <Note>{t('benchmark.config.seed.note')}</Note>,
    side: (
      <span className="flex items-center gap-1.5 self-center rounded-[5px] border px-2 py-0.5 font-mono text-muted-foreground text-xs">
        <LockIcon aria-hidden="true" className="size-3" />{t('benchmark.config.seed.hash', { hash: experiment.seedHash.slice(0, HASH_CHARS) })}
      </span>
    ),
  };
}

// One per experiment (spec, "Workspace"): another workspace is a new experiment, so no trocar
const WorkspaceRow = ({ workspace }: { workspace: string }) => (
  <Row label={L.workspace()} hint={t('benchmark.config.seed.workspace.hint')} side={t('benchmark.config.seed.workspaceSide')}>
    <Pill><WorkspaceSquare name={workspace} />{workspace}</Pill>
  </Row>
);

function SeedRows({ experiment, edit }: SeedProps) {
  const { seed } = experiment;
  const { command, url, files } = seed.sample;
  const isSampleEmpty = files.length === 0 && command === '' && url === '';
  return (
    <>
      <WorkspaceRow workspace={seed.workspace} />
      <Row label={L.commit()} hint={t('benchmark.config.seed.commit.hint')} side={<EditButton edit={edit} label={t('benchmark.config.change')} />}>
        <Pill isMono>{commitText(seed)}</Pill><Pill>{t('benchmark.config.seed.origin')}</Pill>
      </Row>
      <Row label={L.reference()} hint={t('benchmark.config.seed.reference.hint')} side={<EditButton edit={edit} />}>
        {seed.reference.length === 0 ? <None /> : seed.reference.map((entry) => <EntryPill key={entry} entry={entry} />)}
      </Row>
      <Row label={L.sample()} hint={t('benchmark.config.seed.sample.hint')} side={<EditButton edit={edit} />}>
        {isSampleEmpty && <None />}
        {files.map((entry) => <EntryPill key={entry} entry={entry} />)}
        {command !== '' && <Pill isMono>{command}</Pill>}
        {url !== '' && <Pill isMono>{url}</Pill>}
      </Row>
      <Row label={L.scenarios()} hint={t('benchmark.config.seed.scenarios.hint')} side={<EditButton edit={edit} />}><Pill>{scenariosText(seed.scenarios)}</Pill></Row>
    </>
  );
}

function ScenarioRows({ scenarios, onChange }: { scenarios: BenchScenario[]; onChange(next: BenchScenario[]): void }) {
  const set = (i: number, patch: Partial<BenchScenario>): void => onChange(scenarios.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <span className="flex w-full flex-col gap-2">
      {scenarios.map((s, i) => {
        const n = i + 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: ids are editable (blank or repeated while typing), so the position is the only stable key
          <fieldset key={i} aria-label={t('benchmark.config.seed.scenario', { n })} className="grid grid-cols-[4.5rem_minmax(0,1fr)_2rem] items-start gap-2">
            <Field label={t('benchmark.config.seed.scenarioId', { n })} value={s.id} onChange={(id) => set(i, { id })} className="w-full font-mono" />
            <span className="flex flex-col gap-1">
              <Field label={t('benchmark.config.seed.scenarioTitle', { n })} value={s.title} onChange={(title) => set(i, { title })} className="w-full" />
              <Textarea aria-label={t('benchmark.config.seed.scenarioText', { n })} rows={2} value={s.text} onChange={(e) => set(i, { text: e.target.value })} className="text-xs" />
            </span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('benchmark.config.seed.scenarioRemove', { n })} onClick={() => onChange(scenarios.filter((_, j) => j !== i))}><XIcon /></Button>
          </fieldset>
        );
      })}
      <Button type="button" variant="ghost" size="xs" className="self-start" onClick={() => onChange([...scenarios, { id: nextScenarioId(scenarios), title: '', text: '' }])}>
        {t('benchmark.config.seed.scenarioAdd')}
      </Button>
    </span>
  );
}

// A 404 unknown_path names the entry first in its message: the form shows the copy under the list that holds it, never the route's words
function missingOf(err: unknown, seed: BenchSeed): { path: string; list: EntryList } | undefined {
  const { error, message = '' } = refusalOf(err);
  const path = [...seed.reference, ...seed.sample.files].find((entry) => message.startsWith(`${entry} `));
  if (error !== 'unknown_path' || path === undefined) return undefined;
  return { path, list: seed.reference.includes(path) ? 'reference' : 'files' };
}

const seedOf = (draft: BenchSeed): BenchSeed => ({ ...draft, commit: draft.commit.trim(), scenarios: draft.scenarios.map((s) => ({ ...s, id: s.id.trim() })) });

function SeedForm({ experiment, edit }: SeedProps) {
  const [draft, setDraft] = useDraft(() => experiment.seed, edit);
  const [missing, setMissing] = useState<{ path: string; list: EntryList }>();
  const { isSaving, save } = useSave(experiment.id, edit);
  const set = (patch: Partial<BenchSeed>): void => setDraft({ ...draft, ...patch });
  const setSample = (patch: Partial<BenchSeed['sample']>): void => set({ sample: { ...draft.sample, ...patch } });
  const isCommitValid = COMMIT_SHA.test(draft.commit.trim());
  const areScenariosValid = scenarioIdsValid(draft.scenarios);
  const unknown = (list: EntryList): string | undefined => (missing?.list === list ? t('benchmark.config.seed.unknownPath', { path: missing.path }) : undefined);
  const onRefusal = (err: unknown): boolean => { const found = missingOf(err, draft); setMissing(found); return found !== undefined; };
  const fork = experiment.rounds.length > 0 ? { notice: t('benchmark.config.seed.forkNotice'), saveLabel: t('benchmark.config.seed.saveAsNew') } : {};
  const entries = { experimentId: experiment.id };
  return (
    <Section {...seedHead(experiment)} foot={<EditFoot edit={edit} isValid={isCommitValid && areScenariosValid} isSaving={isSaving} onSave={() => void save('seed', seedOf(draft), onRefusal)} {...fork} />}>
      <WorkspaceRow workspace={draft.workspace} />
      <Row label={L.commit()} hint={t('benchmark.config.seed.commit.hint')}>
        <Field label={L.commit()} value={draft.commit} onChange={(commit) => set({ commit })} className="w-80 font-mono" error={isCommitValid ? undefined : t('benchmark.config.error.commit')} />
      </Row>
      <Row label={L.reference()} hint={t('benchmark.config.seed.reference.hint')}><SeedEntries {...entries} label={L.reference()} entries={draft.reference} onChange={(reference) => set({ reference })} error={unknown('reference')} /></Row>
      <Row label={L.sample()} hint={t('benchmark.config.seed.sample.hint')}>
        <SeedEntries {...entries} label={L.sample()} entries={draft.sample.files} onChange={(files) => setSample({ files })} error={unknown('files')} />
        <Field label={t('benchmark.config.seed.command')} value={draft.sample.command} onChange={(command) => setSample({ command })} className="w-56 font-mono" />
        <Field label={t('benchmark.config.seed.url')} value={draft.sample.url} onChange={(url) => setSample({ url })} className="w-56 font-mono" />
      </Row>
      <Row label={L.scenarios()} hint={t('benchmark.config.seed.scenarios.hint')}>
        <ScenarioRows scenarios={draft.scenarios} onChange={(scenarios) => set({ scenarios })} />
        {!areScenariosValid && <FieldError>{t('benchmark.config.error.scenarioIds')}</FieldError>}
      </Row>
    </Section>
  );
}

/** seed (#463): the problem, the same for every arm; saving it on an experiment with rounds forks a new draft (root design, "Hashes"). */
export function SeedSection({ experiment, edit }: SeedProps) {
  if (edit.isOpen) return <SeedForm experiment={experiment} edit={edit} />;
  return <Section {...seedHead(experiment)}><SeedRows experiment={experiment} edit={edit} /></Section>;
}
