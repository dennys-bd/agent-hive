// The report tab's routes (#467): the report under a filter, report.md as a download, and a new evaluation of every ended run.
import { toast } from 'sonner';
import type { ReportFilter } from '../../../../benchmark/report.js';
import type { Experiment } from '../../../../types.js';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';

const REPORT_FILE = 'report.md';
const pathOf = (experimentId: string): string => `/benchmark/experiments/${encodeURIComponent(experimentId)}`;

export const reportPath = (experimentId: string, filter: ReportFilter): string => `${pathOf(experimentId)}/report?filter=${filter}`;

/** GET …/report.md (the route writes the file, then answers it) saved through a blob URL and an <a download>: the same in the Electron
 *  window and a browser. Shared by the tab's button and the ⋯ menu's item. */
export async function downloadReport(experiment: Experiment): Promise<void> {
  try {
    const res = await fetch(`${pathOf(experiment.id)}/${REPORT_FILE}`);
    if (!res.ok) throw new Error(`${REPORT_FILE} answered ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: REPORT_FILE }).click();
    setTimeout(() => URL.revokeObjectURL(url)); // the next tick: by then the click has started the download from the URL
  } catch {
    toast.error(t('benchmark.report.failed.export')); // the route logs its own failure; the UI logs nothing (#461's rule)
  }
}

/** POST …/evaluate (#474): resolves on the 202; a rejection carries parseJson's status (409: an evaluation is under way). */
export async function evaluateAgain(experimentId: string): Promise<void> {
  await postJson<unknown>(`${pathOf(experimentId)}/evaluate`);
}
