/**
 * Diary Markdown helpers: single-pass image-reference scanning and replacement,
 * plus bounded summary extraction for list cards.
 */
const TITLE_MAX_LENGTH = 60
const PREVIEW_MAX_LENGTH = 200
const SUMMARY_SOURCE_MAX_LENGTH = 16 * 1024

export interface MarkdownImageToken {
  reference: string
  referenceStart: number
  referenceEnd: number
}

/** Single forward scan; each character is visited a constant number of times, so unclosed alt text never backtracks per start position. */
export function scanDiaryImageReferences(markdown: string): MarkdownImageToken[] {
  const tokens: MarkdownImageToken[] = []
  let cursor = 0
  while (cursor < markdown.length) {
    if (markdown[cursor] !== '!' || markdown[cursor + 1] !== '[') {
      cursor++
      continue
    }
    let end = cursor + 2
    while (
      end < markdown.length &&
      markdown[end] !== ']' &&
      markdown[end] !== '\r' &&
      markdown[end] !== '\n'
    )
      end++
    if (markdown[end] !== ']' || markdown[end + 1] !== '(') {
      cursor = Math.max(cursor + 2, end + 1)
      continue
    }
    const start = end + 2
    end = start
    while (
      end < markdown.length &&
      markdown[end] !== ')' &&
      markdown[end] !== '\r' &&
      markdown[end] !== '\n'
    )
      end++
    if (markdown[end] === ')' && end - start <= 100) {
      const reference = markdown.slice(start, end)
      if (
        /^draft-image:\/\/[A-Za-z0-9_-]{1,80}$/.test(reference) ||
        /^diary-image:\/\/[0-9a-f-]{36}$/i.test(reference)
      ) {
        tokens.push({ reference, referenceStart: start, referenceEnd: end })
      }
    }
    cursor = end + 1
  }
  return tokens
}

/** Replaces only actual image tokens, not identical strings in plain text. */
export function replaceDiaryImageReferences(
  markdown: string,
  replacements: ReadonlyMap<string, string>
): string {
  const pieces: string[] = []
  let cursor = 0
  for (const token of scanDiaryImageReferences(markdown)) {
    const replacement = replacements.get(token.reference)
    if (!replacement) continue
    pieces.push(markdown.slice(cursor, token.referenceStart), replacement)
    cursor = token.referenceEnd
  }
  pieces.push(markdown.slice(cursor))
  return pieces.join('')
}

function stripInline(source: string): string {
  const output: string[] = []
  let cursor = 0
  while (cursor < source.length) {
    const image = source[cursor] === '!' && source[cursor + 1] === '['
    if (source[cursor] === '[' || image) {
      const start = cursor + (image ? 2 : 1)
      let close = start
      while (close < source.length && source[close] !== ']') close++
      if (close < source.length && source[close + 1] === '(') {
        let end = close + 2
        while (end < source.length && source[end] !== ')') end++
        if (end < source.length) {
          output.push(source.slice(start, close).replace(/[*_`~]/g, ''))
          cursor = end + 1
          continue
        }
        output.push(source.slice(cursor).replace(/[*_`~]/g, ''))
        break
      }
      output.push(source.slice(cursor, close + 1).replace(/[*_`~]/g, ''))
      cursor = close + 1
      continue
    }
    if (!'*_`~'.includes(source[cursor])) output.push(source[cursor])
    cursor++
  }
  return output.join('')
}

export interface DiarySummaryContent {
  title: string
  preview: string
}

/** The summary inspects only a bounded prefix, so scanning never grows with the full body or malicious Markdown. */
export function summarizeDiaryContent(markdown: string): DiarySummaryContent {
  const source = markdown.slice(0, SUMMARY_SOURCE_MAX_LENGTH).replace(/\r\n?/g, '\n')
  let title = ''
  const preview: string[] = []
  let inFence = false
  let cursor = 0
  const visible: string[] = []
  while (cursor < source.length) {
    if (source.startsWith('```', cursor)) {
      inFence = !inFence
      if (!inFence) visible.push(' ')
      cursor += 3
      continue
    }
    if (!inFence) visible.push(source[cursor])
    cursor++
  }
  for (const line of source.split('\n')) {
    if (title) break
    const heading = /^ {0,3}#{1,6}[ \t]+/.exec(line)
    if (heading)
      title = line
        .slice(heading[0].length)
        .trimEnd()
        .replace(/#+$/, '')
        .trim()
        .replace(/[*_`~[\]]/g, '')
        .slice(0, TITLE_MAX_LENGTH)
  }
  for (const line of visible.join('').split('\n')) {
    let text = line.trim()
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) continue
    text = text
      .replace(/^#{1,6}[ \t]+/, '')
      .replace(/^>[ \t]?/, '')
      .replace(/^(?:[-+*]|\d+[.)])[ \t]+/, '')
      .replace(/^\[[ xX]\][ \t]+/, '')
    text = stripInline(text).trim()
    if (text) preview.push(text)
  }
  return { title, preview: preview.join(' ').slice(0, PREVIEW_MAX_LENGTH) }
}
