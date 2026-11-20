import { useState } from 'react';
import type { ParsedTemplate, TemplateError } from '../../../template';
import type { ChainSpec } from '../../../template-condition';
import { type EditResult, isHeldText } from '../../../template-edit';
import { type ChainBlock, chainReach, markerReach } from '../../../template-preview';
import { ChainForm, Reach } from '@/components/plugins/ChainForm';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { type Draft, draftOf, type FormVariable, rawMarkers, specOf } from '@/lib/chain-draft';
import { branchLabel } from '@/lib/template-view';

export interface ConditionPopoverProps {
  chain: ChainBlock; parsed: ParsedTemplate; variables: readonly FormVariable[]; workspaces: readonly string[];
  onOk(spec: ChainSpec): EditResult; onRemove(): EditResult; onClose(): void;
  onReveal(line: number): void; // the else line's jump (#492)
}

// replaceChain refuses to drop a block that holds text at that block's line; the copy is the user's words, the edit's own message goes nowhere
const refusalText = (error: TemplateError): string =>
  isHeldText(error) ? t('plugins.chain.heldText', { line: error.line }) : t('plugins.chain.failed');

// Decision 14: a chain the form cannot show faithfully stays as its text, with each block's reach, and can only lose its markers
function RawChain({ chain, parsed, workspaces }: Pick<ConditionPopoverProps, 'chain' | 'parsed' | 'workspaces'>) {
  const reach = markerReach(parsed, rawMarkers(chain), workspaces);
  return (
    <>
      {chain.branches.map((branch, index) => (
        <div key={branch.line} className="flex flex-col gap-1.5"><p className="font-mono">{branchLabel(branch)}</p><Reach names={reach[index] ?? []} isElse={branch.marker === 'else'} /></div>
      ))}
      <p className="text-muted-foreground">{t('plugins.chain.raw')}</p>
    </>
  );
}

/** The chip's popover (#322, handoff 11l): the whole chain in ChainForm, each block's reach recomputed from the draft, ok / remove condition;
 * the raw view when the form cannot hold a condition. Esc and a click outside close it through the Popover around it (TemplateText). */
export function ConditionPopover({ chain, parsed, variables, workspaces, onOk, onRemove, onClose, onReveal }: ConditionPopoverProps) {
  const [initial] = useState(() => draftOf(chain, variables));
  const [draft, setDraft] = useState<Draft | null>(initial);
  const [refusal, setRefusal] = useState<string>();
  const spec = draft === null ? null : specOf(draft, variables);
  const settle = (result: EditResult): void => { if (result.ok) onClose(); else setRefusal(refusalText(result.error)); };
  const ok = (): void => {
    if (spec === null) return;
    if (JSON.stringify(draft) === JSON.stringify(initial)) onClose(); // decision 17: an unchanged form rewrites nothing
    else settle(onOk(spec));
  };
  const change = (next: Draft): void => { setDraft(next); setRefusal(undefined); };
  // #492: the else the text holds now, not the draft's, since the draft's else has no line until ok writes it
  const elseLine = chain.branches.find((branch) => branch.marker === 'else')?.line;
  const elseJump = elseLine === undefined ? undefined : { line: elseLine, onJump: () => { onReveal(elseLine); onClose(); } };
  return (
    <div className="flex flex-col gap-2 text-xs">
      {draft === null ? <RawChain chain={chain} parsed={parsed} workspaces={workspaces} /> : (
        <>
          <p className="text-muted-foreground">{t('plugins.chain.when')}</p>
          <ChainForm draft={draft} variables={variables} onChange={change} reach={spec === null ? undefined : chainReach(parsed, spec, workspaces)} canAddTerm elseJump={elseJump} />
        </>
      )}
      {refusal && <p role="alert" className="text-destructive">{refusal}</p>}
      <div className="flex items-center gap-1.5 border-t pt-2">
        {draft !== null && <Button type="button" size="xs" disabled={spec === null} onClick={ok}>{t('plugins.chain.ok')}</Button>}
        <Button type="button" variant="outline" size="xs" onClick={() => settle(onRemove())}>{t('plugins.chain.remove')}</Button>
        <span className="text-muted-foreground">{t('plugins.chain.textKept')}</span>
      </div>
    </div>
  );
}
