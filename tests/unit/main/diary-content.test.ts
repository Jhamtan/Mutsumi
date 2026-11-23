import { describe, expect, it } from 'vitest'
import {
  replaceDiaryImageReferences,
  scanDiaryImageReferences,
  summarizeDiaryContent
} from '../../../src/main/services/diary-content'

/**
 * Tests the Markdown summarizer used for diary list cards: title extraction,
 * syntax stripping, plain-text preview, and truncation.
 */
describe('summarizeDiaryContent', () => {
  it('extracts the first heading as the title', () => {
    expect(summarizeDiaryContent('# Hello world\n\nSome body.').title).toBe('Hello world')
  })

  it('strips inline formatting from the extracted title', () => {
    expect(summarizeDiaryContent('## **Bold** Title').title).toBe('Bold Title')
  })

  it('returns an empty title when there is no heading', () => {
    expect(summarizeDiaryContent('Just a plain paragraph.').title).toBe('')
  })

  it('strips bold, links, inline code and images for a plain preview', () => {
    const { preview } = summarizeDiaryContent(
      '**Bold** and [a link](https://example.com) and `code`.'
    )
    expect(preview).toBe('Bold and a link and code.')
  })

  it('strips list markers, blockquotes and headings', () => {
    const { preview } = summarizeDiaryContent('# Title\n\n- one\n- two\n\n> quote')
    expect(preview).toBe('Title one two quote')
  })

  it('drops fenced code block content and keeps image alt text', () => {
    const { preview } = summarizeDiaryContent(
      '```js\nconst secret = 1\n```\n\n![alt text](data:image/png;base64,abc)'
    )
    expect(preview).toContain('alt text')
    expect(preview).not.toContain('const secret')
  })

  it('collapses blank lines and trims whitespace', () => {
    expect(summarizeDiaryContent('  first line  \n\n\n  second line  ').preview).toBe(
      'first line second line'
    )
  })

  it('truncates the preview to the configured length', () => {
    const long = 'word '.repeat(500)
    const { preview } = summarizeDiaryContent(long)
    expect(preview.length).toBeLessThanOrEqual(200)
  })

  it('handles empty input', () => {
    expect(summarizeDiaryContent('')).toEqual({ title: '', preview: '' })
  })

  it('单向扫描大量未闭合图片 alt 并找到后续完整 token', () => {
    const malformed = '!['.repeat(500_000)
    const markdown = `${malformed}\n![ok](draft-image://ok)`
    expect(scanDiaryImageReferences(markdown).map((token) => token.reference)).toEqual([
      'draft-image://ok'
    ])
    expect(summarizeDiaryContent(markdown).preview.length).toBeLessThanOrEqual(200)
  })

  it('摘要不读取有限前缀之后的超长正文', () => {
    const markdown = `${'body '.repeat(10_000)}\n# Beyond preview budget`
    expect(summarizeDiaryContent(markdown).title).toBe('')
  })

  it('只替换图片引用，不改普通文本中的 draft 地址', () => {
    const markdown = 'draft-image://one\n![one](draft-image://one)'
    expect(
      replaceDiaryImageReferences(markdown, new Map([['draft-image://one', 'diary-image://saved']]))
    ).toBe('draft-image://one\n![one](diary-image://saved)')
  })
})
