import { useState } from 'react';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

export interface IssueCommentBoxProps {
  path: string; // the comments route it posts to: an issue's (#757) or a PR's (#758)
  repository: string; // owner/name: what its footer names
  label?: string; // the field's label and placeholder; an issue's by default
  onPosted(): Promise<void>;
}

/** The comment box (#757, #758, handoff 01): posts to `path` whatever header the page has, ⌘↵ or comentar; disabled while the body is empty
 * or a post is out. Once GitHub took it the box empties and the page reads again; a refusal is act's toast. */
export function IssueCommentBox({ path, repository, label = t('issue.comment.placeholder'), onPosted }: IssueCommentBoxProps) {
  const [body, setBody] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const isEmpty = body.trim() === '';
  const post = async (): Promise<void> => {
    if (isEmpty || isPosting) return;
    setIsPosting(true);
    const answer = await act<unknown>(path, { body });
    setIsPosting(false);
    if (answer === undefined) return;
    setBody('');
    await onPosted();
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <Textarea
        aria-label={label} placeholder={label} value={body} rows={3} onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); void post(); } }}
      />
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="flex-1">{t('issue.comment.footer', { repository })}</span>
        <Button type="button" size="xs" disabled={isEmpty || isPosting} onClick={() => void post()}>{t('issue.comment.send')} ⌘↵</Button>
      </div>
    </div>
  );
}
