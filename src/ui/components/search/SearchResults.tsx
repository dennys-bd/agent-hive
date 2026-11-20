import { ChevronDownIcon, ChevronRightIcon, ReplaceIcon } from 'lucide-react';
import { Fragment, type KeyboardEvent, useState } from 'react';
import { t } from '@/i18n';
import type { FileAt } from '@/lib/editor-models';
import { fileSpans, type Segment, segmentsOf } from '@/lib/search-replace';
import type { SearchFileResult, SearchMatch } from '../../../types';

// The mark: the handoff's own tint, the ring at 35%
const MARK = 'rounded-sm bg-[color-mix(in_oklab,var(--ring)_35%,transparent)] text-foreground';

function Match({ segment }: { segment: Extract<Segment, { kind: 'match' }> }) {
  const { text, replacement } = segment;
  if (replacement === undefined) return <mark className={MARK}>{text}</mark>;
  return <mark className={MARK}><s className="bg-diff-del line-through">{text}</s>{replacement !== '' && <ins className="bg-diff-add no-underline">{replacement}</ins>}</mark>;
}

/** A match line: the text before the first match gives way first (cut at its start), the match never clips. Every span of the line is marked,
 * and with a replacement each shows the old struck and the new inserted. */
function MatchText({ match, replacement }: { match: SearchMatch; replacement?: string }) {
  const segments = segmentsOf(match, replacement);
  const lead = segments[0]?.kind === 'text' ? segments[0].text : '';
  const rest = lead === '' ? segments : segments.slice(1);
  const [first, ...tail] = rest;
  if (first === undefined || first.kind === 'text') return <span className="min-w-0 flex-1 truncate">{match.text}</span>;
  let at = match.text.length - tail.reduce((n, s) => n + s.text.length, 0);
  return (
    <span className="flex min-w-0 flex-1 overflow-hidden whitespace-pre font-mono text-soft text-xs">
      <span className="min-w-[3ch] max-w-[12ch] shrink overflow-hidden text-ellipsis text-left [direction:rtl]"><bdi>{lead}</bdi></span>
      <span className="shrink-0"><Match segment={first} /></span>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">
        {tail.map((segment) => {
          const key = at; // the segment's offset in the line: unique and stable
          at += segment.text.length;
          return segment.kind === 'match' ? <Match key={key} segment={segment} /> : <Fragment key={key}>{segment.text}</Fragment>;
        })}
      </span>
    </span>
  );
}

interface FileGroupProps {
  file: SearchFileResult; isOpen: boolean; isDirty: boolean; replacement?: string
  onToggle(): void; onOpen(file: string, at: FileAt): void; onReplaceFile?(file: SearchFileResult): void
}

function FileGroup({ file, isOpen, isDirty, replacement, onToggle, onOpen, onReplaceFile }: FileGroupProps) {
  const slash = file.file.lastIndexOf('/');
  const name = file.file.slice(slash + 1);
  const Chevron = isOpen ? ChevronDownIcon : ChevronRightIcon;
  const onKey = (event: KeyboardEvent): void => {
    // the file's own replace button keeps its Enter
    if ((event.key !== 'Enter' && event.key !== ' ') || event.target !== event.currentTarget) return;
    event.preventDefault();
    onToggle();
  };
  // an unsaved file shows the plain highlight: the results come from the saved file, which replace would not change
  const preview = isDirty ? undefined : replacement;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only holds one file's row and its matches
    <div role="group" className="group">
      <div role="treeitem" tabIndex={0} aria-selected={false} aria-expanded={isOpen} title={isDirty ? t('search.unsavedTitle') : undefined} onClick={onToggle} onKeyDown={onKey} className="flex h-6 items-center gap-1 rounded-sm pr-1 pl-0.5 hover:bg-accent">
        <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{name}</span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-muted-foreground text-xs [direction:rtl]">{slash < 0 ? '' : file.file.slice(0, slash)}</span>
        {isDirty && <span className="shrink-0 rounded-sm bg-muted px-1 text-[11px] text-muted-foreground">{t('search.unsaved')}</span>}
        <span className="min-w-[18px] shrink-0 rounded-full bg-muted px-1.5 text-center text-[11px] tabular-nums">{fileSpans(file)}</span>
        {onReplaceFile !== undefined && (
          <button
            type="button" aria-label={t('search.replaceFile', { name })} title={t('search.replaceFileTitle')} disabled={isDirty}
            onClick={(event) => { event.stopPropagation(); onReplaceFile(file); }}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-0 group-hover:opacity-100 group-hover:disabled:opacity-40"
          >
            <ReplaceIcon aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
      {isOpen && file.matches.map((match) => (
        <button
          key={match.line} type="button" role="treeitem" aria-selected={false} aria-label={`${match.line} ${match.text}`}
          onClick={() => onOpen(file.file, { line: match.line, col: (match.spans[0]?.[0] ?? 0) + 1 })}
          className="flex h-[22px] w-full items-baseline gap-1.5 rounded-sm pr-1 pl-[22px] text-left leading-[22px] hover:bg-accent"
        >
          <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">{match.line}</span>
          <MatchText match={match} replacement={preview} />
        </button>
      ))}
    </div>
  );
}

interface ResultsProps {
  files: SearchFileResult[]; onOpen(file: string, at: FileAt): void
  /** Set with the replace field open: the rows preview it. */
  replacement?: string; dirty?: ReadonlySet<string>; onReplaceFile?(file: SearchFileResult): void
}

/** The results, grouped by file: a file's row folds its matches, a match row opens the file at its line and column. */
export function SearchResults({ files, onOpen, replacement, dirty, onReplaceFile }: ResultsProps) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string): void => setClosed((now) => { const next = new Set(now); if (!next.delete(path)) next.add(path); return next; });
  return (
    <div role="tree" aria-label={t('search.tree')} className="min-h-0 flex-1 overflow-auto px-1.5 pb-2 text-[13px]">
      {files.map((file) => (
        <FileGroup key={file.file} file={file} isOpen={!closed.has(file.file)} isDirty={dirty?.has(file.file) ?? false} replacement={replacement} onToggle={() => toggle(file.file)} onOpen={onOpen} onReplaceFile={onReplaceFile} />
      ))}
    </div>
  );
}
