import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { t } from '@/i18n';
import type { FileAt } from '@/lib/editor-models';
import type { SearchFileResult, SearchMatch } from '../../../types';

// The mark: the handoff's own tint, the ring at 35%
const MARK = 'rounded-sm bg-[color-mix(in_oklab,var(--ring)_35%,transparent)] text-foreground';
const countOf = (file: SearchFileResult): number => file.matches.reduce((n, m) => n + m.spans.length, 0);

/** A match line: the text before the first match gives way first (cut at its start), the match never clips. */
function MatchText({ match }: { match: SearchMatch }) {
  const [first, ...rest] = match.spans;
  if (first === undefined) return <span className="min-w-0 flex-1 truncate">{match.text}</span>;
  const tail: ReactNode[] = [];
  let at = first[1];
  for (const [start, end] of rest) {
    tail.push(match.text.slice(at, start), <mark key={start} className={MARK}>{match.text.slice(start, end)}</mark>);
    at = end;
  }
  tail.push(match.text.slice(at));
  return (
    <span className="flex min-w-0 flex-1 overflow-hidden whitespace-pre font-mono text-soft text-xs">
      <span className="min-w-[3ch] max-w-[12ch] shrink overflow-hidden text-ellipsis text-left [direction:rtl]"><bdi>{match.text.slice(0, first[0])}</bdi></span>
      <mark className={`shrink-0 ${MARK}`}>{match.text.slice(first[0], first[1])}</mark>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{tail}</span>
    </span>
  );
}

interface FileGroupProps { file: SearchFileResult; isOpen: boolean; onToggle(): void; onOpen(file: string, at: FileAt): void }

function FileGroup({ file, isOpen, onToggle, onOpen }: FileGroupProps) {
  const slash = file.file.lastIndexOf('/');
  const Chevron = isOpen ? ChevronDownIcon : ChevronRightIcon;
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only holds one file's row and its matches
    <div role="group">
      <div role="treeitem" tabIndex={0} aria-selected={false} aria-expanded={isOpen} onClick={onToggle} onKeyDown={onKey} className="flex h-6 items-center gap-1 rounded-sm pr-1 pl-0.5 hover:bg-accent">
        <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{file.file.slice(slash + 1)}</span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-muted-foreground text-xs [direction:rtl]">{slash < 0 ? '' : file.file.slice(0, slash)}</span>
        <span className="min-w-[18px] shrink-0 rounded-full bg-muted px-1.5 text-center text-[11px] tabular-nums">{countOf(file)}</span>
      </div>
      {isOpen && file.matches.map((match) => (
        <button
          key={match.line} type="button" role="treeitem" aria-selected={false} aria-label={`${match.line} ${match.text}`}
          onClick={() => onOpen(file.file, { line: match.line, col: (match.spans[0]?.[0] ?? 0) + 1 })}
          className="flex h-[22px] w-full items-baseline gap-1.5 rounded-sm pr-1 pl-[22px] text-left leading-[22px] hover:bg-accent"
        >
          <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">{match.line}</span>
          <MatchText match={match} />
        </button>
      ))}
    </div>
  );
}

/** The results, grouped by file: a file's row folds its matches, a match row opens the file at its line and column. */
export function SearchResults({ files, onOpen }: { files: SearchFileResult[]; onOpen(file: string, at: FileAt): void }) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string): void => setClosed((now) => { const next = new Set(now); if (!next.delete(path)) next.add(path); return next; });
  return (
    <div role="tree" aria-label={t('search.tree')} className="min-h-0 flex-1 overflow-auto px-1.5 pb-2 text-[13px]">
      {files.map((file) => <FileGroup key={file.file} file={file} isOpen={!closed.has(file.file)} onToggle={() => toggle(file.file)} onOpen={onOpen} />)}
    </div>
  );
}
