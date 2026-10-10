import { createContext, useContext } from 'react';
import type { FileDiff } from '../../types';
import type { SurfaceAnchor, SurfaceConversation, SurfaceDraft } from '@/lib/surface';

/** Where a comment box opens (#591): on an anchor, new, or on a draft to edit. */
export interface CommentTarget { anchor: SurfaceAnchor; draft?: SurfaceDraft }
/** Where a comment sent now goes on the sessions surface (#591): its chips, else the picked session; replaces: the draft it was, dropped once sent. */
export interface CommentOptions { to?: string[]; mentions?: string[]; replaces?: string }
/** The diff pane's own pieces (#591): sessão padrão, reenviar, and the sends in flight that are not failures yet. With it the session picker,
 * mentions, respondendo and não entregue render; without it, none does. */
export interface SessionsPart { defaultSession: string; chooseDefault(session: string): void; retry(conversation: string, message: string): void; isSending: boolean }
/** enviar revisão (#591, #592): errors are the footer's lines in destructive. */
export interface SubmitPart { canSubmit: boolean; submit(): void; errors: string[] }

/** What a review view draws and does (#592): the shared components read it; the diff pane and the PR page each build their own. */
export interface ReviewSurface {
  footer: string; // the footer's name: revisão, revisão do PR
  readOnly: boolean; // a merged or closed PR: conversations only
  conversations(file: FileDiff): SurfaceConversation[];
  drafts(path: string): SurfaceDraft[];
  counts: { drafts: number; open: number };
  reviewed(file: FileDiff): boolean;
  mark(file: FileDiff, reviewed: boolean): void;
  edit(target: CommentTarget): void; // editar on a draft: the box opens on it
  comment(anchor: SurfaceAnchor, text: string, options?: CommentOptions): Promise<void>;
  addDraft(anchor: SurfaceAnchor, text: string, session?: string): Promise<void>;
  editDraft(id: string, text: string, session?: string): Promise<void>;
  reply(conversation: string, text: string, mentions?: string[]): Promise<void>;
  resolve(conversation: string, resolved: boolean): Promise<void>;
  submit?: SubmitPart; // enviar revisão: the diff pane's; the PR page sends its reviews from its popover (#758)
  openFile?(file: FileDiff): void; // abrir arquivo: the diff pane's only
  sessions?: SessionsPart;
}

export const ReviewSurfaceContext = createContext<ReviewSurface | undefined>(undefined);

export function useReviewSurface(): ReviewSurface {
  const surface = useContext(ReviewSurfaceContext);
  if (surface === undefined) throw new Error('useReviewSurface outside a review pane');
  return surface;
}
