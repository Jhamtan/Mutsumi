import { describe, expect, it } from 'vitest'
import { formatMarkdown, renderMarkdown } from '../../../src/renderer/src/utils/markdown'

/**
 * Tests Markdown rendering and formatting: GFM support, sanitization of active
 * content, draft image reference resolution, and idempotent lint fixes.
 */
describe('Markdown utilities', () => {
  it('renders common Markdown, GFM and images', () => {
    const html = renderMarkdown(
      '# Title\n\n- [x] Done\n\n~~old~~\n\n![Sample](data:image/png;base64,AAAA)'
    )

    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<del>old</del>')
    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).toContain('loading="lazy"')
  })

  it('sanitizes active content, event handlers, styles and unsafe links', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><img src="x" onerror="alert(2)" style="display:none">\n\n' +
        '[unsafe](javascript:alert(3))'
    )

    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('unsafe')
  })

  it('resolves short draft image references before final sanitization', () => {
    const html = renderMarkdown('![Sample](draft-image://image-id)', (reference) => {
      expect(reference).toBe('draft-image://image-id')
      return 'data:image/png;base64,AAAA'
    })

    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).toContain('loading="lazy"')
  })

  it('does not accept unsafe output from an image resolver', () => {
    // Resolver output is sanitized again, so a resolver cannot inject javascript: URLs.
    const html = renderMarkdown('![Sample](draft-image://image-id)', () => 'javascript:alert(1)')

    expect(html).not.toContain('javascript:')
  })

  it('removes unresolved or irrelevant compact image references', () => {
    expect(renderMarkdown('![Saved](diary-image://saved-id)', () => undefined)).not.toContain(
      'src='
    )
    expect(
      renderMarkdown('![Remote](https://example.com/image.png)', () => 'data:image/png;base64,AAAA')
    ).toContain('src="https://example.com/image.png"')
  })

  it('escapes image alt text and titles before sanitization', () => {
    const html = renderMarkdown('![A & B](https://example.com/a.png "x & y")')
    expect(html).toContain('alt="A &amp; B"')
    expect(html).toContain('title="x &amp; y"')
  })

  it('applies markdownlint whitespace and block-spacing fixes', () => {
    expect(formatMarkdown('#Heading\r\nText\t\r\n-   one\r\n- two\r\nAfter')).toBe(
      '# Heading\n\nText\n\n- one\n- two\n\nAfter\n'
    )
  })

  it('adds blank lines around fenced code while preserving its content', () => {
    const source = 'Intro\n```text\n- not a list  \n\n\nvalue  \n```\n- real list\nEnd'

    expect(formatMarkdown(source)).toBe(
      'Intro\n\n```text\n- not a list  \n\n\nvalue  \n```\n\n- real list\n\nEnd\n'
    )
  })

  it('is idempotent and handles empty content', () => {
    const formatted = formatMarkdown('\nText\n\n\n1. Item\n\n')

    expect(formatted).toBe('Text\n\n1. Item\n')
    expect(formatMarkdown(formatted)).toBe(formatted)
    expect(formatMarkdown(' \n\n')).toBe('')
  })
})
