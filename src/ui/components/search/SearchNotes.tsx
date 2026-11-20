import { Fragment, type ReactNode } from 'react';
import { t, type MessageKey } from '@/i18n';
import { displayBinding } from '../../../shortcuts';
import { binding, isMac } from '@/lib/shortcut-bindings';

const NOTE = 'flex flex-col gap-1.5 px-3 py-2 text-xs leading-[18px] text-muted-foreground text-pretty';

// A message's {name} slots filled with nodes (the repos in <b>, a key in <kbd>): the text is split on the slots, as the dictionaries keep them
function rich(key: MessageKey, slots: Record<string, ReactNode>): ReactNode {
  return t(key).split(/(\{\w+\})/).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are a fixed split of one message, never reordered
    return <Fragment key={i}>{name === undefined ? piece : (slots[name] ?? piece)}</Fragment>;
  });
}

const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

/** The key quick-open is bound to, for display: the files ⌘P lists are the ones busca searches. */
function quickOpenKeys(): string {
  const keys = binding('search');
  return keys === null ? t('shortcuts.search') : displayBinding(keys, isMac());
}

/** No query yet: what busca searches, and the nested repositories it takes in. */
export function EmptyNote({ repos }: { repos: string[] }) {
  const slots = { key: <Kbd>{quickOpenKeys()}</Kbd>, repos: <b className="font-medium text-foreground">{repos.join(', ')}</b> };
  return (
    <div className={NOTE}>
      <span>{rich(repos.length > 0 ? 'search.emptyNoteNested' : 'search.emptyNote', slots)}</span>
      <span>{rich('search.openHint', { key: <Kbd>{isMac() ? '↵' : 'Enter'}</Kbd> })}</span>
    </div>
  );
}

/** The activity has no worktree: nothing to search. */
export function NoWorktreeNote() {
  return <div className={NOTE}><span>{t('search.noWorktree')}</span><span>{t('search.noWorktreeHint')}</span></div>;
}

export function NoResultsNote({ text }: { text: string }) {
  return <div className={NOTE}><span>{text}</span></div>;
}

/** The cap strip: the search stopped at its limit. */
export function CapNote({ text }: { text: string }) {
  return <div className="mx-1.5 mt-0.5 mb-1.5 rounded-md border px-2 py-1.5 text-muted-foreground text-xs leading-[17px]">{text}</div>;
}
