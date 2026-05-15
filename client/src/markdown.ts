import { marked } from 'marked';

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // Drop raw HTML blocks to prevent XSS — return an empty string instead.
    html(): string { return ''; },
  },
});

/** Render a Markdown string to an HTML string using marked. */
export function renderMarkdown(src: string): string {
  return marked.parse(src ?? '', { async: false }) as string;
}
