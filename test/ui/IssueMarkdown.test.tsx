import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { IssueMarkdown } from '@/components/IssueMarkdown';

test('renders the issue body with GitHub\'s extensions: a heading, a task list and a table', () => {
  render(<IssueMarkdown text={'## Plan\n\n- [x] spec\n- [ ] build\n\n| a | b |\n|---|---|\n| 1 | 2 |'} />);
  expect(screen.getByRole('heading', { level: 2, name: 'Plan' })).toBeInTheDocument();
  const boxes = screen.getAllByRole('checkbox');
  expect(boxes).toHaveLength(2);
  expect(boxes[0]).toBeChecked();
  expect(boxes[1]).not.toBeChecked();
  expect(screen.getByRole('table')).toBeInTheDocument();
});

test('raw HTML is text and never an element, and every link (written or autolinked) opens outside the app', () => {
  const { container } = render(<IssueMarkdown text={'<script>alert(1)</script>\n\n[the issue](https://github.com/acme/r/issues/1) and https://example.com'} />);
  expect(container.querySelector('script')).toBeNull();
  expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  const links = screen.getAllByRole('link');
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  }
});

test('only absolute http(s) URLs survive (mailto too, for links): a relative image or link cannot make the app request its own server', () => {
  const text = '![x](/repositories/o/n/pulls/1) ![y](//evil.test/a.png) ![z](https://example.com/a.png) ![m](mailto:a@b.c)\n\n'
    + '[rel](/tasks/1) [rel2](other/page) [js](javascript:alert(1)) [mail](mailto:a@b.c) [abs](http://example.com)';
  const { container } = render(<IssueMarkdown text={text} />);
  expect(Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src'))).toEqual([null, null, 'https://example.com/a.png', null]);
  expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([null, null, null, 'mailto:a@b.c', 'http://example.com']);
});
