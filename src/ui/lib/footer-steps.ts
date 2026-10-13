// The footer's responsive steps (#227, handoff §6): what fits depends on the content (the agent count, the rules' text), not only on the
// width, so the footer measures its rendered row instead of mounting a hidden copy per step of groups that poll and hold state.
import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';
import type { UsageForm } from '@/components/footer/AgentUsage';
import type { RulesForm } from '@/lib/rule-effects';

export type FooterStep = { usage: UsageForm; rules: RulesForm };

/** Handoff §6's order: for each usage form, the full rules first, the short ones only when those do not fit. */
export const STEPS: readonly FooterStep[] = [
  { usage: 'full', rules: 'full' },
  { usage: 'full', rules: 'short' },
  { usage: 'compact', rules: 'full' },
  { usage: 'compact', rules: 'short' },
  { usage: 'minimal', rules: 'full' },
  { usage: 'minimal', rules: 'short' },
  { usage: 'group', rules: 'full' },
  { usage: 'group', rules: 'short' },
];
export const LAST_STEP = STEPS.length - 1;

/** One step down while the content overflows; the last step stays, and the row clips what still does not fit. */
export const nextStep = (step: number, overflows: boolean): number => (overflows && step < LAST_STEP ? step + 1 : step);

/** The footer's step (#227): the first of STEPS whose content fits `ref`'s width, found again from step 0 on a new width or `fitKey`. */
export function useFooterStep(ref: RefObject<HTMLElement | null>, fitKey: string): FooterStep {
  const [step, setStep] = useState(0);
  const [key, setKey] = useState(fitKey);
  // A resize while already at step 0 would bail out of setStep(0) and never re-measure; the counter forces the render
  const [, setResizes] = useState(0);
  // Content that shrinks (an agent gone, a rule no longer in force) frees room no resize reports: start over in this same render
  if (key !== fitKey) {
    setKey(fitKey);
    setStep(0);
  }
  // After every render and before paint, so the descent never shows; React bails out once the step stops changing
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null) setStep((current) => nextStep(current, el.scrollWidth > el.clientWidth));
  });
  // A new width starts over from the largest step: one rule for the window growing back and for it shrinking. The observer's first call
  // (on observe) carries the same width and changes nothing.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      setStep(0);
      setResizes((n) => n + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return STEPS[step];
}
