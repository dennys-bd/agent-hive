import { useEffect, useState } from 'react';
import type { LinkType } from '../../types';
import { readRelationTypes } from '@/lib/relations-api';

/** The types the relations add row offers (#829), read once per mount: the section is keyed by task, so once per open panel. A failed read
 * offers none, which hides + add; the next open reads again. */
export function useRelationTypes(source: string): LinkType[] {
  const [types, setTypes] = useState<LinkType[]>([]);
  useEffect(() => {
    let isStale = false;
    readRelationTypes(source).then((read) => { if (!isStale) setTypes(read); }, () => { if (!isStale) setTypes([]); });
    return () => { isStale = true; };
  }, [source]);
  return types;
}
