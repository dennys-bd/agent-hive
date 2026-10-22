import { useState } from 'react';
import { isLocked } from '../../../../benchmark/arms.js';
import type { Experiment } from '../../../../types.js';
import type { SectionId } from '@/components/benchmark/config/config-lib';
import { PaceSection } from '@/components/benchmark/config/PaceSection';
import { SeedSection } from '@/components/benchmark/config/SeedSection';
import { Note, type SectionEdit } from '@/components/benchmark/config/Section';
import { Confirm } from '@/components/Confirm';
import type { TabContext } from '@/components/benchmark/tabs';
import { t } from '@/i18n';

export interface ConfigTabProps { experiment: Experiment; context: TabContext }

interface SectionEdits { isLocked: boolean; editOf(id: SectionId): SectionEdit; asked?: SectionId; confirm(): void; dismiss(): void }

// One section in edit at a time (spec, "Editing model"): another over unsaved changes asks first (the Confirm below draws the ask); a status that locks
// closes the form unsaved, for good, adjusted during render as React's "state from props" pattern does
function useSectionEdits(experiment: Experiment, context: TabContext): SectionEdits {
  const [editing, setEditing] = useState<SectionId>();
  const [isDirty, setDirty] = useState(false);
  const [asked, setAsked] = useState<SectionId>();
  const isLockedNow = isLocked(experiment);
  if (isLockedNow && editing !== undefined) {
    setEditing(undefined);
    setDirty(false);
  }
  const go = (id: SectionId | undefined): void => {
    setEditing(id);
    setDirty(false);
    setAsked(undefined);
  };
  const editOf = (id: SectionId): SectionEdit => ({
    isOpen: !isLockedNow && editing === id, isLocked: isLockedNow,
    open: () => (editing !== undefined && editing !== id && isDirty ? setAsked(id) : go(id)),
    close: () => go(undefined), markDirty: () => setDirty(true),
    saved: (answer) => {
      go(undefined);
      if (answer !== experiment.id) context.select(answer); // a seed edit forked: the dock selects the new draft, the tab stays on config
    },
  });
  return { isLocked: isLockedNow, editOf, asked, confirm: () => go(asked), dismiss: () => setAsked(undefined) };
}

/** The benchmark view's config tab (#463, benchmark.hv.html's #s-config): the five sections in one column, each read-only until its editar
 * opens it as a form; while the experiment runs or sleeps the routes answer 409, so nothing is editable and the note says why. */
export function ConfigTab({ experiment, context }: ConfigTabProps) {
  const edits = useSectionEdits(experiment, context);
  const { isLocked: isLockedNow, editOf } = edits;
  return (
    <div className="flex flex-col gap-[22px] px-6 py-5">
      {isLockedNow && <Note>{t('benchmark.config.locked')}</Note>}
      <SeedSection experiment={experiment} edit={editOf('seed')} />
      <PaceSection experiment={experiment} edit={editOf('pace')} rateLimits={context.rateLimits} />
      <Confirm
        open={edits.asked !== undefined} onOpenChange={(open) => { if (!open) edits.dismiss(); }}
        title={t('benchmark.config.discardTitle')} message={t('benchmark.config.discardText')} confirmLabel={t('benchmark.config.discard')} onConfirm={edits.confirm}
      />
    </div>
  );
}
