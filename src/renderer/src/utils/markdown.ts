/**
 * Markdown rendering for the preview pane: a customized marked renderer plus
 * DOMPurify sanitization, with image reference resolution for local drafts.
 */
import DOMPurify from 'dompurify'
import { Renderer, marked, type Tokens } from 'marked'

const renderer = new Renderer()

/** Escape attribute text generated from Markdown tokens. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Add lazy loading to preview images. DOMPurify still performs the final
 * allow-list sanitization, including URL-scheme checks for `src`.
 */
renderer.image = ({ href, title, text }: Tokens.Image) => {
  const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : ''
  return `<img src="${escapeAttribute(href)}" alt="${escapeAttribute(text)}"${titleAttribute} loading="lazy">`
}

/** Convert Markdown to sanitized HTML safe for the Electron renderer. */
export function renderMarkdown(
  source: string,
  resolveImage?: (reference: string) => string | undefined
): string {
  const parsed = marked.parse(source, {
    async: false,
    breaks: true,
    gfm: true,
    renderer
  })

  let html = parsed
  if (resolveImage) {
    // Replace only image references produced by the Markdown parser. The result is
    // sanitized afterwards, so a parent resolver cannot inject unsafe markup.
    const template = document.createElement('template')
    template.innerHTML = parsed
    for (const image of template.content.querySelectorAll('img')) {
      const reference = image.getAttribute('src') ?? ''
      if (!reference.startsWith('draft-image://') && !reference.startsWith('diary-image://'))
        continue

      const resolved = resolveImage(reference)
      if (resolved) image.setAttribute('src', resolved)
      else image.removeAttribute('src')
    }
    html = template.innerHTML
  }

  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['loading'],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['form', 'iframe', 'object', 'embed', 'style'],
    FORBID_ATTR: ['style', 'target']
  })
}

export { formatMarkdown } from './markdown-format'
export {
  commonMarkdownSyntaxExamples,
  defaultMarkdownEditorLabels,
  markdownSyntaxExamples,
  type MarkdownEditorLabels,
  type MarkdownSyntaxKey
} from './markdown-help'
