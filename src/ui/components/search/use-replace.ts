import { useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { WriteCancelled } from '@/lib/api';
import * as models from '@/lib/editor-models';
import { fileSpans, replaceIn } from '@/lib/search-replace';
import { formatCount, t } from '@/i18n';
import { type ReplaceAnswer, SEARCH_CAP, type SearchFileResult, type SearchQuery } from '../../../types';
import { showReplaced, undoWithNotice } from './replace-toast';

interface ReplaceInput { activityId: string; query: SearchQuery; replacement: string; files: SearchFileResult[]; rerun(): void }

/** The files with unsaved edits in the editor among the results: replace works on the saved file, so they are left out. */
function useDirty(activityId: string, files: SearchFileResult[]): ReadonlySet<string> {
  const joined = useSyncExternalStore(models.subscribe, () => files.filter((f) => models.isDirty(activityId, f.file)).map((f) => f.file).join('\0'));
  return useMemo(() => new Set(joined === '' ? [] : joined.split('\0')), [joined]);
}

/** Replace in one file or in all (#868): the request, the notice with its undo, and a new search once the disk changed. */
export function useReplace({ activityId, query, replacement, files, rerun }: ReplaceInput) {
  const dirty = useDirty(activityId, files);
  const [isConfirmOpen, setConfirmOpen] = useState(false);
  const clean = files.filter((f) => !dirty.has(f.file));
  const run = async (targets: SearchFileResult[], file?: string): Promise<void> => {
    try {
      const answer: ReplaceAnswer = await replaceIn(activityId, { query, replacement, files: targets.map((f) => f.file) });
      showReplaced(answer, { file, isAll: file === undefined, onUndo: () => { void undoWithNotice(activityId, answer).then(rerun); } });
    } catch (error) {
      // the server's refusal is English; the page words this one itself
      if (!(error instanceof WriteCancelled)) toast.error((error as { code?: string }).code === 'too_many_matches' ? t('search.replaceTooMany', { n: formatCount(SEARCH_CAP) }) : error instanceof Error ? error.message : String(error));
    }
    rerun(); // the results read the disk again, whatever the answer
  };
  return {
    dirty, isConfirmOpen, setConfirmOpen,
    plan: { files: clean.length, occurrences: clean.reduce((n, f) => n + fileSpans(f), 0), dirty: files.filter((f) => dirty.has(f.file)).map((f) => f.file) },
    replaceFile: (file: SearchFileResult): void => { void run([file], file.file.slice(file.file.lastIndexOf('/') + 1)); },
    replaceAll: (): void => { setConfirmOpen(false); void run(clean); },
  };
}
