import Markdown, { type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Links leave the app, like the PR and issue links already do. Raw HTML stays off (react-markdown turns it into text), and the
// library's default urlTransform drops javascript: and other unsafe URLs: an issue body is untrusted text.
const COMPONENTS: Components = {
  a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
};
// A body is untrusted and the app serves its own API on the same origin: a relative src or href (`![](/repositories/o/n/pulls/1)`) would make
// the window GET its own server. Only absolute http(s) URLs pass, and mailto for links.
const urlTransform: UrlTransform = (url, key) => (/^https?:\/\//i.test(url) || (key === 'href' && /^mailto:/i.test(url)) ? url : null);
const PLUGINS = [remarkGfm];

// No typography plugin: just enough for an issue body to read as one inside the panel.
const PROSE = [
  'flex flex-col gap-2 break-words text-sm',
  '[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_a]:underline',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_li]:ml-4 [&_.contains-task-list]:list-none',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-background [&_pre]:p-2',
  '[&_table]:text-xs [&_td]:border [&_td]:px-1 [&_th]:border [&_th]:px-1',
].join(' ');

/** An issue body or a comment, as GitHub-flavoured markdown. */
export function IssueMarkdown({ text }: { text: string }) {
  return (
    <div className={PROSE}>
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={urlTransform}>{text}</Markdown>
    </div>
  );
}
