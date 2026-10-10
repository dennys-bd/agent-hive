import { useState } from 'react';
import type { FileDiff } from '../../types';
import { CountsText } from '@/components/DiffFile';
import { Input } from '@/components/ui/input';
import { type MessageKey, t } from '@/i18n';
import { countsOf } from '@/lib/diff-rows';

// A file's mark and its status colour (#591): M waiting (a rename reads M), A working, D destructive
const MARK: Record<FileDiff['status'], { letter: string; tone: string }> = {
  modified: { letter: 'M', tone: 'text-waiting' }, renamed: { letter: 'M', tone: 'text-waiting' },
  added: { letter: 'A', tone: 'text-working' }, deleted: { letter: 'D', tone: 'text-destructive' },
};
const STATUS_KEY: Record<FileDiff['status'], MessageKey> = {
  added: 'diff.status.added', deleted: 'diff.status.deleted', modified: 'diff.status.modified', renamed: 'diff.status.renamed',
};

/** A path's folder, trailing slash kept, and its name (#591). */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/');
  return { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

interface FileRowProps { file: FileDiff; isOpen: boolean; isReviewed: boolean; count: number; onOpen(path: string): void; onReviewed(file: FileDiff): void }

function FileRow({ file, isOpen, isReviewed, count, onOpen, onReviewed }: FileRowProps) {
  const { dir, name } = splitPath(file.path);
  const mark = MARK[file.status];
  return (
    <li className={`flex h-7 items-center gap-2 px-2 ${isOpen ? 'bg-muted' : ''} ${isReviewed ? 'opacity-55' : ''}`}>
      <input type="checkbox" className="size-3.5 shrink-0" aria-label={t('diff.markReviewed', { path: file.path })} checked={isReviewed} onChange={() => onReviewed(file)} />
      <button type="button" aria-current={isOpen ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onOpen(file.path)}>
        <span title={t(STATUS_KEY[file.status])} className={`w-3 shrink-0 font-mono ${mark.tone}`}>{mark.letter}</span>
        <span className="min-w-0 flex-1 truncate font-mono"><span className="text-muted-foreground">{dir}</span>{name}</span>
        {count > 0 && <span className="rounded-full bg-muted px-1.5 text-muted-foreground">{count}</span>}
        {!file.binary && <CountsText counts={countsOf(file.hunks)} />}
      </button>
    </li>
  );
}

interface DiffFileListProps {
  files: FileDiff[]; open?: string; isReviewed(file: FileDiff): boolean; onOpen(path: string): void; onReviewed(file: FileDiff): void;
  comments(path: string): number; // a file's drafts and conversations in the scope (#591)
}

/** The pane's file list (#591): 280px, a filter on the path (substring, any case), one 28px row per file. */
export function DiffFileList({ files, open, isReviewed, onOpen, onReviewed, comments }: DiffFileListProps) {
  const [filter, setFilter] = useState('');
  const needle = filter.toLowerCase();
  const shown = files.filter((file) => file.path.toLowerCase().includes(needle));
  return (
    <nav aria-label={t('diff.fileList')} className="flex w-[280px] shrink-0 flex-col border-r">
      <div className="flex items-center gap-2 border-b p-2">
        <Input value={filter} placeholder={t('diff.filter')} aria-label={t('diff.filter')} className="h-7 text-xs" onChange={(e) => setFilter(e.target.value)} />
        <span className="shrink-0 text-muted-foreground">{t('review.withComments', { n: files.filter((f) => comments(f.path) > 0).length })}</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {shown.map((file) => <FileRow key={file.path} file={file} isOpen={file.path === open} isReviewed={isReviewed(file)} count={comments(file.path)} onOpen={onOpen} onReviewed={onReviewed} />)}
      </ul>
    </nav>
  );
}
