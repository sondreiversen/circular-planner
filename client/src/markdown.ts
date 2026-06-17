import { marked, Tokens } from 'marked';

/**
 * Schemes we accept on Markdown link / image hrefs. Anything else (most
 * importantly `javascript:` and `data:`) is rewritten to `#` so user-controlled
 * descriptions can't smuggle code-execution URLs into the rendered HTML.
 *
 * `mailto:` and `tel:` are common in planner descriptions ("contact owner@…")
 * and are safe to allow.
 */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

function sanitizeHref(raw: string | null | undefined): string {
  if (!raw) return '#';
  const trimmed = raw.trim();
  // Relative URLs and fragments are always fine.
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) return trimmed;
  // Anything with a scheme: parse and allow-list. Use URL with a base so
  // single-slash protocol-relative URLs (//evil.com) resolve to https:.
  try {
    const url = new URL(trimmed, 'https://localhost/');
    if (SAFE_SCHEMES.includes(url.protocol)) return trimmed;
  } catch {
    // Not a parseable URL — treat as unsafe.
  }
  return '#';
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // Drop raw HTML blocks to prevent XSS — return an empty string instead.
    html(): string { return ''; },
    // Sanitize link hrefs (block javascript: / data: / unknown schemes).
    link(token: Tokens.Link): string {
      const href = sanitizeHref(token.href);
      const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      // Use the parser's own rendering for the link text (preserves emphasis).
      const text = (this as unknown as { parser: { parseInline(tokens: Tokens.Generic[]): string } })
        .parser.parseInline(token.tokens);
      // External links open in a new tab with noopener for safety.
      const isExternal = /^https?:/i.test(href);
      const targetRel = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escapeAttr(href)}"${title}${targetRel}>${text}</a>`;
    },
    // Sanitize image src too — same threat surface.
    image(token: Tokens.Image): string {
      const src = sanitizeHref(token.href);
      const alt = escapeAttr(token.text || '');
      const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      return `<img src="${escapeAttr(src)}" alt="${alt}"${title}>`;
    },
  },
});

/** Render a Markdown string to an HTML string using marked. */
export function renderMarkdown(src: string): string {
  return marked.parse(src ?? '', { async: false }) as string;
}
