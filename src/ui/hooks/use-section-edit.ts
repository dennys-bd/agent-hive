import { useState } from 'react';
import type { RefGrammar } from '../../blocker-refs';
import { blockerErrorText } from '@/lib/blocker-errors';

/** What a relations section's edits show (#57, #829): the pending row's key and the last refusal's copy. */
export interface SectionEdit<C> { pending: string | undefined; error: string | undefined; edit(key: string, change: C): Promise<boolean> }

/** One edit at a time per section, and no optimistic change (#57): the list stays as the state has it, so a refusal needs no rollback, only
 * its copy. The blockers and the relations sections share it (#829); `send` is each one's route. */
export function useSectionEdit<C>(send: (change: C) => Promise<unknown>, grammar: RefGrammar | undefined): SectionEdit<C> {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const edit = async (key: string, change: C): Promise<boolean> => {
    setPending(key);
    setError(undefined);
    try {
      await send(change);
      return true;
    } catch (err) {
      setError(blockerErrorText(err, grammar));
      return false;
    } finally {
      setPending(undefined);
    }
  };
  return { pending, error, edit };
}
