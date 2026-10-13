import { type RefObject, useEffect, useEffectEvent, useState } from 'react';
import { parseTweaks, settle, type TweakSchema } from '../../design-tweaks';
import type { DesignTweakValue } from '../../types';
import { bridgeData } from '@/hooks/use-design-pins';

// A design pane's tweaks (#241): the frame's hv-tweaks block, parsed here since the frame's content is untrusted, and the values the mounted
// pane holds for its file, like the theme: nothing is stored. The frame forgets them on every load, so they go again after every ready.

export type TweakBlock = { status: 'none' } | { status: 'invalid' } | { status: 'ok'; schema: TweakSchema };
type Values = Readonly<Record<string, DesignTweakValue>>;
const NO_TWEAKS: TweakSchema = [];

/** What the bridge's tweaks message says (#241): the block parsed, else invalid, whether its JSON broke or its rules fail. */
export function blockOf(data: Record<string, unknown>): TweakBlock {
  if (data.error !== undefined) return { status: 'invalid' };
  const parsed = parseTweaks(data.schema);
  return parsed.ok ? { status: 'ok', schema: parsed.schema } : { status: 'invalid' };
}

const schemaOf = (block: TweakBlock): TweakSchema => (block.status === 'ok' ? block.schema : NO_TWEAKS);

// '*': the sandboxed frame's origin is opaque (#108); a tweak's value is nothing to hide
function postValues(frame: HTMLIFrameElement | null, values: Values): void {
  for (const [name, value] of Object.entries(values)) frame?.contentWindow?.postMessage({ hive: 'design', type: 'tweak', name, value }, '*');
}

export interface DesignTweaks {
  block: TweakBlock; schema: TweakSchema; values: Values;
  set(name: string, value: DesignTweakValue): void; apply(values: Values): void; repost(): void;
}

export function useDesignTweaks(frame: RefObject<HTMLIFrameElement | null>): DesignTweaks {
  const [block, setBlock] = useState<TweakBlock>({ status: 'none' });
  const [held, setHeld] = useState<Values>({});
  const schema = schemaOf(block);
  const values = settle(schema, held);
  // A new block (a load) settles the values against it and sends them at once: the ready just before sent them for the old one
  const onBlock = useEffectEvent((next: TweakBlock) => {
    const settled = settle(schemaOf(next), held);
    setBlock(next);
    setHeld(settled);
    postValues(frame.current, settled);
  });
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = bridgeData(event, frame.current);
      if (data?.type === 'tweaks') onBlock(blockOf(data));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame]);
  const apply = (next: Values): void => {
    const settled = settle(schema, next);
    setHeld(settled);
    postValues(frame.current, settled);
  };
  const set = (name: string, value: DesignTweakValue): void => {
    const settled = settle(schema, { ...values, [name]: value });
    setHeld(settled);
    postValues(frame.current, { [name]: settled[name] });
  };
  return { block, schema, values, set, apply, repost: () => postValues(frame.current, values) };
}
