import 'katex/dist/katex.min.css';
import { InfoIcon, LightbulbIcon, type LucideIcon, MessageSquareWarningIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import Markdown, { type Components, type ExtraProps, type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import remarkGemoji from 'remark-gemoji';
import remarkGfm from 'remark-gfm';
import remarkGithub from 'remark-github';
import remarkMath from 'remark-math';
import { MermaidDiagram } from '@/components/MermaidDiagram';
import { type MessageKey, t } from '@/i18n';
import { isExternalHref } from '@/lib/doc-links';
import { ALERT_KINDS, type AlertKind, isAlertKind, remarkAlerts } from '@/lib/remark-alerts';

type Plugins = NonNullable<Options['remarkPlugins']>;
type HastElement = NonNullable<ExtraProps['node']>;

// GitHub's allowlist (the sanitizer's default schema: details, summary, kbd, tables and img stay; script, style, iframe, event handlers and
// javascript: URLs go), plus the alerts' aside and its kind, and the classes remark-math puts on code (#697)
const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'aside'],
  // Only what IssueMarkdown opens too: no other scheme gets a href, so no click can navigate to one
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'] },
  attributes: {
    ...defaultSchema.attributes,
    aside: [['dataAlert', ...ALERT_KINDS]],
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};
// The plugin's documents as GitHub renders them (#697). Raw HTML is parsed (rehype-raw), then sanitized. KaTeX runs after the sanitizer: its
// output is trusted markup (it escapes its input), and sanitizing it would strip it. The slugs run before the sanitizer, so a heading's id
// gets the same user-content- prefix as a raw one: a `# Hive` heading never becomes a global (window.hive). The preview's anchor lookup
// tries the bare id, then the prefixed one
const REMARK: Plugins = [remarkGfm, remarkGemoji, remarkAlerts, remarkMath];
const REHYPE: Plugins = [rehypeRaw, rehypeSlug, [rehypeSanitize, SCHEMA], rehypeKatex];
// #123, owner/repo#123, @user and commit SHAs as GitHub links (#697), only with the task's repository: a local activity has none
const remarkFor = (repository?: string): Plugins => (repository === undefined ? REMARK : [...REMARK, [remarkGithub, { repository }]]);

// Each alert's icon and title (#697)
const ALERT: Record<AlertKind, { Icon: LucideIcon; title: MessageKey }> = {
  note: { Icon: InfoIcon, title: 'preview.alert.note' },
  tip: { Icon: LightbulbIcon, title: 'preview.alert.tip' },
  important: { Icon: MessageSquareWarningIcon, title: 'preview.alert.important' },
  warning: { Icon: TriangleAlertIcon, title: 'preview.alert.warning' },
  caution: { Icon: OctagonAlertIcon, title: 'preview.alert.caution' },
};

// IssueMarkdown's prose, grown for whole documents: heading sizes and scroll margins, quotes, and details with a muted disclosure marker.
// Colour only from the tokens, links in foreground (docs/agent/design-system.md)
const PROSE = [
  'flex flex-col gap-3 break-words text-sm leading-relaxed',
  '[&_h1]:font-semibold [&_h1]:text-xl [&_h2]:font-semibold [&_h2]:text-lg [&_h3]:font-semibold [&_h3]:text-base [&_h4]:font-semibold',
  '[&_:is(h1,h2,h3,h4,h5,h6)]:scroll-mt-4 [&_a]:text-foreground [&_a]:underline',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_li]:ml-5 [&_.contains-task-list]:list-none',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_table]:text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1',
  '[&_details]:rounded-md [&_details]:border [&_details]:px-3 [&_details]:py-2 [&_summary]:cursor-pointer [&_summary]:marker:text-muted-foreground',
].join(' ');

// An alert (#697): its icon and title in muted-foreground over its body, inside a neutral border. GitHub colours each kind; the design system
// keeps colour for status
function AlertAside({ kind, children }: { kind: AlertKind; children: ReactNode }) {
  const { Icon, title } = ALERT[kind];
  return (
    <aside data-alert={kind} className="flex flex-col gap-1 rounded-md border px-3 py-2">
      <p className="flex items-center gap-1.5 font-medium text-muted-foreground"><Icon aria-hidden="true" className="size-4" />{t(title)}</p>
      {children}
    </aside>
  );
}

// The code of a ```mermaid block (#697): the pre's one code child with the language-mermaid class, as text; undefined for any other pre
function mermaidCode(pre: HastElement | undefined): string | undefined {
  const code = pre?.children[0];
  if (code?.type !== 'element' || code.tagName !== 'code') return undefined;
  const classes = code.properties.className;
  if (!Array.isArray(classes) || !classes.includes('language-mermaid')) return undefined;
  return code.children.map((child) => (child.type === 'text' ? child.value : '')).join('').replace(/\n$/, '');
}

// Links (#697): http(s) and mailto open outside, as IssueMarkdown's do; any other (an anchor, a file) goes to the preview's onLink. An aside
// remark-alerts marked draws as its alert, a mermaid block as its diagram
function componentsFor(onLink: (href: string) => void): Components {
  return {
    a: ({ node: _node, href, children, ...props }) => (href !== undefined && isExternalHref(href)
      ? <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>
      // auxclick: a middle click would otherwise open the file's or the anchor's URL in a new window of the Electron shell
      : <a {...props} href={href} onAuxClick={(event) => event.preventDefault()} onClick={(event) => { event.preventDefault(); if (href !== undefined) onLink(href); }}>{children}</a>),
    aside: ({ node, children, ...props }) => {
      const kind = node?.properties.dataAlert;
      return isAlertKind(kind) ? <AlertAside kind={kind}>{children}</AlertAside> : <aside {...props}>{children}</aside>;
    },
    pre: ({ node, children, ...props }) => {
      const code = mermaidCode(node);
      return code === undefined ? <pre {...props}>{children}</pre> : <MermaidDiagram code={code} />;
    },
  };
}

/** repository: the task's `owner/name` (item.facets.repository), for its #N and @user links; undefined, they stay text. */
export interface DocMarkdownProps { text: string; repository?: string; onLink(href: string): void }

/** A markdown document from the disk, rendered as GitHub renders it (#697): the preview pane's body. IssueMarkdown stays as it is: an issue
 * body keeps raw HTML off. */
export function DocMarkdown({ text, repository, onLink }: DocMarkdownProps) {
  return (
    <div className={PROSE}>
      <Markdown remarkPlugins={remarkFor(repository)} rehypePlugins={REHYPE} components={componentsFor(onLink)}>{text}</Markdown>
    </div>
  );
}
