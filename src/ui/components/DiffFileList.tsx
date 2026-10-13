import { useState } from 'react';
import type { FileDiff } from '../../types';
import { CountsText } from '@/components/DiffFile';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { type MessageKey, t, tPlural } from '@/i18n';
import { countsOf, splitPath } from '@/lib/diff-rows';

const STATUS_KEY: Record<FileDiff['status'], MessageKey> = {
  added: 'diff.status.added', deleted: 'diff.status.deleted', modified: 'diff.status.modified', renamed: 'diff.status.renamed',
};
// The name carries the status (#853), the letter gone: added working, deleted destructive, the rest foreground; muted once reviewed
const NAME_TONE: Record<FileDiff['status'], string> = { added: 'text-working', deleted: 'text-destructive', modified: 'text-foreground', renamed: 'text-foreground' };
const OPEN = 'bg-muted shadow-[inset_2px_0_0_var(--foreground)]';

type ListRow = { kind: 'folder'; dir: string; before: string } | { kind: 'file'; file: FileDiff; dir: string };

// The list's rows in the files' order (#853): a folder row whenever the folder differs from the file before; a root file has none
function listRows(files: FileDiff[]): ListRow[] {
  return files.flatMap((file, index): ListRow[] => {
    const { dir } = splitPath(file.path);
    const previous = index === 0 ? undefined : splitPath(files[index - 1].path).dir;
    const folder: ListRow[] = dir !== '' && dir !== previous ? [{ kind: 'folder', dir, before: file.path }] : [];
    return [...folder, { kind: 'file', file, dir }];
  });
}

// A static header (#853): the ⌄ is decoration, the design draws no collapsed folder
function FolderRow({ dir }: { dir: string }) {
  return (
    <li className="mt-1 flex h-[26px] items-center gap-1.5 px-2 text-muted-foreground text-xs">
      <span aria-hidden="true" className="text-[10px]">⌄</span>
      <span className="min-w-0 truncate">{dir.slice(0, -1)}</span>
    </li>
  );
}

interface FileRowProps { file: FileDiff; isRoot: boolean; isOpen: boolean; isReviewed: boolean; count: number; onOpen(path: string): void }

function FileRow({ file, isRoot, isOpen, isReviewed, count, onOpen }: FileRowProps) {
  const tone = isReviewed ? 'text-muted-foreground' : NAME_TONE[file.status];
  return (
    <li>
      <button
        type="button" title={t(STATUS_KEY[file.status])} aria-current={isOpen ? 'true' : undefined} onClick={() => onOpen(file.path)}
        className={`flex h-7 w-full items-center gap-2 rounded-sm pr-2 text-left text-[13px] ${isRoot ? 'pl-2' : 'pl-[22px]'} ${isOpen ? OPEN : ''}`}
      >
        <span className={`min-w-0 flex-1 truncate ${tone} ${file.status === 'deleted' ? 'line-through' : ''}`}>{splitPath(file.path).name}</span>
        {count > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px] text-foreground">{count}</span>}
        {!file.binary && <CountsText counts={countsOf(file.hunks)} className="text-[11px]" />}
        <span className="w-3 shrink-0 text-center text-muted-foreground text-xs">{isReviewed ? '✓' : ''}</span>
      </button>
    </li>
  );
}

interface ListHeadProps { files: FileDiff[]; isReviewed(file: FileDiff): boolean; comments(path: string): number; filter: string; onFilter(value: string): void }

// Three rows (#853): the reviewed count with the comment count, the progress, the filter
function ListHead({ files, isReviewed, comments, filter, onFilter }: ListHeadProps) {
  const reviewed = files.filter(isReviewed).length;
  const total = files.reduce((sum, file) => sum + comments(file.path), 0);
  return (
    <div className="flex flex-col gap-2 border-b px-3 py-2.5">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{t('diff.reviewedOf', { n: reviewed, m: files.length })}</span>
        <span className="ml-auto">{tPlural('review.comments', total, { n: total })}</span>
      </div>
      <Progress value={files.length === 0 ? 0 : (reviewed / files.length) * 100} className="h-1 bg-border" indicatorClassName="bg-muted-foreground" />
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground text-xs">⌕</span>
        <Input value={filter} placeholder={t('diff.filter')} aria-label={t('diff.filter')} className="h-7 pl-6 text-xs" onChange={(e) => onFilter(e.target.value)} />
      </div>
    </div>
  );
}

interface DiffFileListProps {
  files: FileDiff[]; open?: string; isReviewed(file: FileDiff): boolean; onOpen(path: string): void;
  comments(path: string): number; // a file's drafts and conversations in the scope (#591)
}

/** The pane's file list (#591, #853): 280px, its head, then the files under their folder rows, filtered on the path (substring, any case).
 * Marking a file reviewed is the card's revisado and V; the list only shows it. */
export function DiffFileList({ files, open, isReviewed, onOpen, comments }: DiffFileListProps) {
  const [filter, setFilter] = useState('');
  const needle = filter.toLowerCase();
  const shown = files.filter((file) => file.path.toLowerCase().includes(needle));
  return (
    <nav aria-label={t('diff.fileList')} className="flex w-[280px] shrink-0 flex-col border-r">
      <ListHead files={files} isReviewed={isReviewed} comments={comments} filter={filter} onFilter={setFilter} />
      <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-auto p-1.5">
        {listRows(shown).map((row) => (row.kind === 'folder'
          ? <FolderRow key={`${row.dir}>${row.before}`} dir={row.dir} />
          : <FileRow key={row.file.path} file={row.file} isRoot={row.dir === ''} isOpen={row.file.path === open} isReviewed={isReviewed(row.file)} count={comments(row.file.path)} onOpen={onOpen} />))}
      </ul>
    </nav>
  );
}
