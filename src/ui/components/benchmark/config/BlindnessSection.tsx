import { type ReactNode, useId } from 'react';
import { EXPERIMENT_PATHS, runBranch } from '../../../../benchmark/names.js';
import type { Experiment } from '../../../../types.js';
import { linesOf } from '@/components/benchmark/config/config-lib';
import { saveSection, toastRefusal } from '@/components/benchmark/config/save-section';
import { EditButton, EditFoot, Pill, Row, Section, type SectionEdit, useDraft, useSave, Values } from '@/components/benchmark/config/Section';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

interface BlindnessProps { experiment: Experiment; edit: SectionEdit }

// One field, so no edit mode (spec, "Blindness"): the switch sends its PATCH at once; the stream brings the new value back
function BlindSwitch({ experiment, isLocked }: { experiment: Experiment; isLocked: boolean }) {
  const id = useId();
  const { blindness } = experiment;
  const toggle = async (on: boolean): Promise<void> => {
    try {
      await saveSection(experiment.id, 'blindness', { ...blindness, on });
    } catch (err) {
      toastRefusal(err);
    }
  };
  return (
    <span className="flex items-center gap-2 self-center text-muted-foreground text-xs">
      <label htmlFor={id}>{t(blindness.on ? 'benchmark.config.blind.on' : 'benchmark.config.blind.off')}</label>
      <Switch id={id} aria-label={t('benchmark.config.blind.switch')} checked={blindness.on} disabled={isLocked} onCheckedChange={(on) => void toggle(on)} />
    </span>
  );
}

const wordsLabel = (): string => t('benchmark.config.blind.words');

// The real names (names.ts): what the baseline drops and what a run's branch is called
function BlindRows({ words, wordsSide }: { words: ReactNode; wordsSide?: ReactNode }) {
  return (
    <>
      <Row label={t('benchmark.config.blind.files')} hint={t('benchmark.config.blind.files.hint')}><Values texts={EXPERIMENT_PATHS} isMono /></Row>
      <Row label={t('benchmark.config.blind.branches')} hint={t('benchmark.config.blind.branches.hint')}>
        <Pill isMono>{runBranch(t('benchmark.config.blind.token'))}</Pill><Pill>{t('benchmark.config.blind.insteadOf')}</Pill>
      </Row>
      <Row label={wordsLabel()} hint={t('benchmark.config.blind.words.hint')} side={wordsSide}>{words}</Row>
    </>
  );
}

function BlindnessForm({ experiment, edit, head }: BlindnessProps & { head: { title: string; sub: string; side: ReactNode } }) {
  const { blindness } = experiment;
  const [text, setText] = useDraft(() => blindness.forbiddenWords.join('\n'), edit);
  const { isSaving, save } = useSave(experiment.id, edit);
  const words = <Textarea aria-label={wordsLabel()} rows={4} spellCheck={false} placeholder={t('benchmark.config.blind.perLine')} value={text} onChange={(e) => setText(e.target.value)} className="w-64 text-xs" />;
  return (
    <Section {...head} isDimmed={!blindness.on} foot={<EditFoot edit={edit} isValid isSaving={isSaving} onSave={() => void save('blindness', { on: blindness.on, forbiddenWords: linesOf(text) })} />}>
      <BlindRows words={words} />
    </Section>
  );
}

/** cegueira (#463, root design "Blindness"): the switch, the files the baseline drops, the neutral branch names and the forbidden words. */
export function BlindnessSection({ experiment, edit }: BlindnessProps) {
  const head = { title: t('benchmark.config.blind.title'), sub: t('benchmark.config.blind.sub'), side: <BlindSwitch experiment={experiment} isLocked={edit.isLocked} /> };
  if (edit.isOpen) return <BlindnessForm experiment={experiment} edit={edit} head={head} />;
  return (
    <Section {...head} isDimmed={!experiment.blindness.on}>
      <BlindRows words={<Values texts={experiment.blindness.forbiddenWords} />} wordsSide={<EditButton edit={edit} />} />
    </Section>
  );
}
