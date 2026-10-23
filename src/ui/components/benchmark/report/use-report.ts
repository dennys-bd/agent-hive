// The report tab's data (#467): GET …/report under the filter, read again on every change of the experiment's object or of the filter.
import { useEffect, useState } from 'react';
import type { BenchReport, ReportFilter } from '../../../../benchmark/report.js';
import type { Experiment } from '../../../../types.js';
import { reportPath } from '@/components/benchmark/report/report-actions';
import { getJson } from '@/lib/api';

export type ReportState = { state: 'loading' } | { state: 'ready'; report: BenchReport } | { state: 'failed' };

// The whole experiment, not its id: a new object in state (a run ended, an evaluation arrived, an inMedian changed) is what asks for a new read
const readReport = (experiment: Experiment, filter: ReportFilter): Promise<BenchReport> => getJson<BenchReport>(reportPath(experiment.id, filter));

/** The experiment's report under the filter. The last ready report stays on screen while a newer one is read; an answer to a request that is
 *  no longer the latest is dropped. */
export function useReport(experiment: Experiment, filter: ReportFilter): ReportState {
  const [answer, setAnswer] = useState<ReportState>({ state: 'loading' });
  useEffect(() => {
    let isLatest = true;
    readReport(experiment, filter).then(
      (report) => { if (isLatest) setAnswer({ state: 'ready', report }); },
      () => { if (isLatest) setAnswer({ state: 'failed' }); },
    );
    return () => { isLatest = false; };
  }, [experiment, filter]);
  return answer;
}
