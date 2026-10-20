import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistAnswer } from '../../assist';
import type { AgentId } from '../../types';
import type { ItemEditor } from '@/hooks/use-item-editor';
import type { MessageKey } from '@/i18n';
import { sendJson } from '@/lib/api';
import type { LineSelection } from '@/lib/assist-view';

export type AssistStatus = 'idle' | 'running' | 'proposed';
export interface AssistPick { agent: AgentId; model: string } // model '' is the CLI's default
/** The editor footer's state for the open file (#331). */
export interface Assist {
  status: AssistStatus;
  request?: string; // the last request sent, for the request line
  answer?: AssistAnswer; // only while status is 'proposed'
  line?: MessageKey; // an idle footer's answer line: no change, or a refusal's copy
  ask(request: string, selection?: LineSelection): boolean; // false when nothing was sent
  accept(): void;
  discard(): void;
}
interface AssistArgs { editor: ItemEditor; path: string; pick: AssistPick; isWritable: boolean }
type AssistState = Pick<Assist, 'status' | 'request' | 'answer' | 'line'>;

const IDLE: AssistState = { status: 'idle' };
// server-assist.ts's AssistCode, each with the Hive's own copy; any other failure reads as unexpected
const REFUSALS: Readonly<Partial<Record<string, MessageKey>>> = {
  busy: 'plugins.assist.busy', agent_unavailable: 'plugins.assist.unavailable', bad_answer: 'plugins.assist.badAnswer', run_failed: 'plugins.assist.failed',
};
const refusalOf = (err: unknown): MessageKey => {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === 'string' ? REFUSALS[code] : undefined) ?? 'plugins.assist.unexpected';
};
const isAnswer = (value: unknown): value is AssistAnswer => {
  const answer = value as Partial<AssistAnswer> | null;
  return typeof answer?.text === 'string' && typeof answer.changed === 'boolean' && Array.isArray(answer.hunk?.lines);
};
// assist.ts's fileLines, which the page does not import (assist.ts brings zod): a final newline ends the last line
const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

// Monaco shows an empty line after a final newline, which the route counts as outside the text: a selection is cut to the file's lines, and
// one left holding none is no selection
function selectionIn(text: string, selection: LineSelection | undefined): LineSelection | undefined {
  if (selection === undefined) return undefined;
  const endLine = Math.min(selection.endLine, lineCount(text));
  return selection.startLine <= endLine ? { startLine: selection.startLine, endLine } : undefined;
}

function answered(request: string, answer: unknown): AssistState {
  if (!isAnswer(answer)) return { status: 'idle', request, line: 'plugins.assist.unexpected' };
  return answer.changed ? { status: 'proposed', request, answer } : { status: 'idle', request, line: 'plugins.assist.noChange' };
}

/** The footer's state (#331): one request at a time over the open file, aborted when EditorBody unmounts (another file, version or item) or
 * the text turns read-only (decision 5). The item editor is locked while a request runs or a proposal waits. A refusal is the answer line,
 * never a toast; the server's words reach the console only. */
export function useAssist({ editor, path, pick, isWritable }: AssistArgs): Assist {
  const [state, setState] = useState<AssistState>(IDLE);
  const flight = useRef<AbortController>(undefined);
  const { setLocked } = editor;
  const drop = useCallback((): void => {
    flight.current?.abort();
    flight.current = undefined;
    setState(IDLE);
  }, []);
  useEffect(() => () => { flight.current?.abort(); setLocked(false); }, [setLocked]);
  useEffect(() => { setLocked(state.status !== 'idle'); }, [state.status, setLocked]);
  useEffect(() => { if (!isWritable) drop(); }, [isWritable, drop]);
  const ask = (request: string, selection?: LineSelection): boolean => {
    const trimmed = request.trim();
    if (trimmed === '' || state.status !== 'idle' || !isWritable || editor.item === undefined) return false;
    const text = editor.textOf(path);
    const within = selectionIn(text, selection);
    const controller = new AbortController();
    flight.current = controller;
    setState({ status: 'running', request: trimmed });
    const body = { version: editor.version, path, text, request: trimmed, ...(within && { selection: within }), agent: pick.agent, ...(pick.model === '' ? {} : { model: pick.model }) };
    sendJson<unknown>('POST', `/api/items/${encodeURIComponent(editor.item.id)}/assist`, body, { signal: controller.signal }).then(
      (answer) => { if (!controller.signal.aborted) setState(answered(trimmed, answer)); },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        console.error('assist: the request was refused', err);
        setState({ status: 'idle', request: trimmed, line: refusalOf(err) });
      },
    );
    return true;
  };
  return {
    ...state, ask,
    accept: () => {
      if (state.answer === undefined) return;
      // a refused edit is the answer line, not a silent drop
      const refusal = editor.applyEdit({ ok: true, text: state.answer.text }, { isSaveForced: true });
      setState(refusal === undefined ? IDLE : { status: 'idle', request: state.request, line: refusal });
    },
    discard: () => setState(IDLE),
  };
}
