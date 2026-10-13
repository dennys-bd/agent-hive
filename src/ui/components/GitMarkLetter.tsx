import type { GitMark } from '../../types';
import { t } from '@/i18n';
import { MARK_TEXT } from '@/lib/tree-status';

/** A file's git mark as the files tree draws it (redesign 07, #903): the letter in its token, named for a screen reader. The search's file
 *  row draws it too (#133). */
export function GitMarkLetter({ mark }: { mark: GitMark }) {
  return (
    <>
      <span aria-hidden data-git-mark title={t(`files.mark.${mark}`)} className={`${MARK_TEXT[mark]} text-xs`}>{mark}</span>
      <span className="sr-only">{`, ${t(`files.mark.${mark}`)}`}</span>
    </>
  );
}
