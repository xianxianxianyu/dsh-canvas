import { Marked } from 'marked'
import { escapeHtml } from './page.ts'

// Raw HTML in a note is shown as the text it is: notes come from files anyone may write, and the
// page they land on must stay script-free whatever its CSP.
const marked = new Marked({ gfm: true, async: false, renderer: { html: ({ text }) => escapeHtml(text) } })

/**
 * Board notes and embedded `.md` files as HTML (GitHub-flavored Markdown, raw HTML escaped).
 * @param source - the Markdown text.
 * @returns HTML for the inside of a note's box.
 */
export function markdownHtml(source: string): string {
  return marked.parse(source, { async: false })
}
