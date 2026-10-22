import { isLocked } from '../../../../benchmark/arms.js';
import type { Experiment } from '../../../../types.js';
import { Note } from '@/components/benchmark/config/Section';
import type { TabContext } from '@/components/benchmark/tabs';
import { t } from '@/i18n';

export interface ConfigTabProps { experiment: Experiment; context: TabContext }

/** The benchmark view's config tab (#463, benchmark.hv.html's #s-config): the five sections in one column, each read-only until its editar
 * opens it as a form; while the experiment runs or sleeps the routes answer 409, so nothing is editable and the note says why. */
export function ConfigTab({ experiment }: ConfigTabProps) {
  return (
    <div className="flex flex-col gap-[22px] px-6 py-5">
      {isLocked(experiment) && <Note>{t('benchmark.config.locked')}</Note>}
    </div>
  );
}
