import type { Express, Request, Response } from 'express';
import { columnOf, isBlocked } from './cards.js';
import { isFree } from './orchestrator.js';
import type { Effect, HiveEvent, State } from './types.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409; // not configured, or the state refuses what was asked
const UNKNOWN_CARD_MESSAGE = 'card desconhecido';
const NO_FREE_SLOT_MESSAGE = 'nenhum slot livre';
const CARD_ON_BOARD_MESSAGE = 'card ainda está no board';

export interface CardRouteDeps {
  requireLive(res: Response): { state: State } | undefined;
  dispatch(event: HiveEvent): Promise<Effect[]>;
}

/** Why a manual start would be a no-op in the reducer, as the answer the route gives; undefined when it can go through. */
function startRefusal(state: State, itemId: string, raiseMax: boolean): { status: number; message: string } | undefined {
  const card = state.cards.find((c) => c.task.itemId === itemId);
  if (!card) return { status: HTTP_NOT_FOUND, message: UNKNOWN_CARD_MESSAGE };
  if (card.slotId !== undefined) return { status: HTTP_CONFLICT, message: 'card já está rodando' };
  if (card.missing) return { status: HTTP_CONFLICT, message: 'card sumiu do board: feche ou mantenha' };
  if (isBlocked(card.task)) return { status: HTTP_CONFLICT, message: `card bloqueado por ${(card.task.blockedBy ?? []).join(', ')}` };
  if (columnOf(state.columns, card.column)?.prompt === undefined) return { status: HTTP_CONFLICT, message: 'coluna sem prompt' };
  if (!raiseMax && !state.slots.some(isFree)) return { status: HTTP_CONFLICT, message: NO_FREE_SLOT_MESSAGE };
  return undefined;
}

/** The user's answer to a card that left the board (fechar / manter): what the reducer would ignore in silence, as the route's answer. */
function cardRefusal(state: State, itemId: string): { status: number; message: string } | undefined {
  const card = state.cards.find((c) => c.task.itemId === itemId);
  if (!card) return { status: HTTP_NOT_FOUND, message: UNKNOWN_CARD_MESSAGE };
  return card.missing ? undefined : { status: HTTP_CONFLICT, message: CARD_ON_BOARD_MESSAGE };
}

// The human override on a stopped card (start) and the human answer to one that left the board (close / keep). The checks
// answer what the reducer would ignore in silence, so the UI is never left without an answer; a race between the check and
// the dispatch is a no-op in the reducer, never a spawn or a close it should not do.
export function registerCardRoutes(app: Express, deps: CardRouteDeps): void {
  const { requireLive, dispatch } = deps;

  app.post('/cards/:id/start', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const itemId = req.params.id as string;
    const raiseMax = (req.body as { raiseMax?: unknown } | undefined)?.raiseMax === true; // only a literal true raises the max
    const refusal = startRefusal(current.state, itemId, raiseMax);
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.message });
      return;
    }
    await dispatch({ type: 'start', itemId, raiseMax });
    res.json({ ok: true });
  });

  for (const [action, type] of [['close', 'closeCard'], ['keep', 'keepCard']] as const) {
    app.post(`/cards/:id/${action}`, async (req: Request, res: Response) => {
      const current = requireLive(res);
      if (!current) return;
      const cardId = req.params.id as string;
      const refusal = cardRefusal(current.state, cardId);
      if (refusal) {
        res.status(refusal.status).json({ error: refusal.message });
        return;
      }
      await dispatch({ type, cardId });
      res.json({ ok: true });
    });
  }
}
