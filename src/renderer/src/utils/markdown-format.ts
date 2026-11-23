/**
 * Format action for the editor: a curated markdownlint profile plus
 * opinionated blank-line normalization around lists and document edges.
 */
import { applyFixes } from 'markdownlint'
import { lint } from 'markdownlint/sync'

/**
 * A focused markdownlint profile for the editor's Format action.
 * It mirrors the whitespace/structure rules commonly fixed by the VS Code
 * markdownlint extension without rewriting a user's preferred heading/list style.
 */
const formatRules = {
  default: false,
  MD009: { br_spaces: 2, code_blocks: false, strict: false },
  MD010: true,
  MD012: true,
  MD018: true,
  MD019: true,
  MD020: true,
  MD021: true,
  MD022: true,
  MD023: true,
  MD027: true,
  MD030: true,
  MD031: true,
  MD032: true,
  MD037: true,
  MD038: true,
  MD039: true,
  MD047: true
}

// A list item (bullet or number) followed by non-empty content.
const listItemPattern = /^\s{0,3}(?:[-+*]|\d+[.)])\s+\S/
// An opening fenced code block marker (``` or ~~~).
const fencePattern = /^\s*(`{3,}|~{3,})/

/**
 * markdownlint correctly treats an unindented line after a list item as a lazy
 * continuation. The editor's Format action is intentionally more opinionated:
 * it interprets that line as surrounding prose so the visible list is wrapped
 * in blank lines, matching the component's documented behavior.
 */
function addBlankLinesAroundLists(source: string): string {
  const lines = source.split('\n')
  const output: string[] = []
  let fenceMarker = ''

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const fenceMatch = line.match(fencePattern)

    if (fenceMarker) {
      output.push(line)
      if (new RegExp(`^\\s*${fenceMarker[0]}{${fenceMarker.length},}\\s*$`).test(line)) {
        fenceMarker = ''
      }
      index += 1
      continue
    }

    if (fenceMatch) {
      fenceMarker = fenceMatch[1]
      output.push(line)
      index += 1
      continue
    }

    if (!listItemPattern.test(line)) {
      output.push(line)
      index += 1
      continue
    }

    if (output.length > 0 && output.at(-1) !== '') output.push('')
    while (index < lines.length) {
      const listLine = lines[index]
      if (listItemPattern.test(listLine) || /^\s{2,}\S/.test(listLine) || listLine === '') {
        output.push(listLine)
        index += 1
        continue
      }
      break
    }
    while (output.at(-1) === '') output.pop()
    if (index < lines.length) output.push('')
  }

  return output.join('\n')
}

/** Remove blank document padding that markdownlint intentionally leaves alone. */
function trimDocumentBlankLines(source: string): string {
  const lines = source.split('\n')
  while (lines[0]?.trim() === '') lines.shift()
  while (lines.at(-1)?.trim() === '') lines.pop()
  return lines.join('\n')
}

/**
 * Applies markdownlint's safe automatic fixes until the document stabilizes.
 * A small iteration cap protects the UI if a future markdownlint version ever
 * reports interacting fixes in a cycle.
 */
export function formatMarkdown(source: string): string {
  let formatted = trimDocumentBlankLines(source.replace(/\r\n?/g, '\n'))
  if (!formatted) return ''

  formatted = addBlankLinesAroundLists(formatted)

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const errors = lint({
      strings: { document: formatted },
      config: formatRules
    }).document
    const next = applyFixes(formatted, errors)

    if (next === formatted) break
    formatted = next
  }

  return formatted
}
