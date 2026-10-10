// Where a link of a previewed markdown file leads (#697): an anchor of the same document, or another file on the disk, resolved against the
// folder of the file it is written in, as markdown means a relative link. http(s) and mailto open outside (DocMarkdown). Pure string work.

const MARKDOWN = /\.(md|markdown)$/i;
const EXTERNAL = /^(https?:|mailto:)/i;
const SCHEME = /^[a-z][a-z\d+.-]*:/i; // another URL the sanitizer let through (xmpp:, irc:): the preview opens nothing for it
const NONE = { kind: 'none' } as const;

/** A markdown file by its name (#697): .md or .markdown, any case. An .mdx file is code here. */
export const isMarkdownPath = (path: string): boolean => MARKDOWN.test(path);

/** A link that leaves the Hive (#697), as IssueMarkdown's links do. */
export const isExternalHref = (href: string): boolean => EXTERNAL.test(href);

/** What a click on a preview's link does (#697). file: the target joined to the previewed file's folder, not normalized yet (fileRefPath does
 * that with the activity's folder), and the anchor to scroll to once it shows. */
export type DocLink = { kind: 'anchor'; id: string } | { kind: 'file'; path: string; isMarkdown: boolean; anchor?: string } | { kind: 'none' };

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // a stray % is a literal
  }
}

/** The link `href` written in the file `from` (#697). A leading / is an absolute disk path, as every route reads one. */
export function docLink(href: string, from: string): DocLink {
  const hash = href.indexOf('#');
  const anchor = hash === -1 ? '' : decode(href.slice(hash + 1));
  const target = decode((hash === -1 ? href : href.slice(0, hash)).split('?')[0]);
  if (target === '') return anchor === '' ? NONE : { kind: 'anchor', id: anchor };
  if (SCHEME.test(target) || target.startsWith('//')) return NONE;
  const slash = from.lastIndexOf('/');
  const path = target.startsWith('/') || slash === -1 ? target : `${from.slice(0, slash + 1)}${target}`;
  return { kind: 'file', path, isMarkdown: isMarkdownPath(path), ...(anchor === '' ? {} : { anchor }) };
}
