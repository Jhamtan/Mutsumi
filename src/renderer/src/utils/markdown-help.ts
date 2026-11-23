/**
 * Shared labels and syntax examples for the Markdown editor and help dialogs.
 */
export interface MarkdownEditorLabels {
  splitMode: string
  sourceMode: string
  format: string
  help: string
  more: string
  insertImage: string
  imageTooLarge: string
  imageReadFailed: string
  imageAlt: string
  editor: string
  preview: string
  emptyPreview: string
  syntaxTitle: string
  syntaxDescription: string
  syntax: Record<MarkdownSyntaxKey, string>
}

/**
 * All syntax rows shown by the detailed help dialog.
 * `common` marks the compact subset displayed in the hover card.
 */
export const markdownSyntaxExamples = [
  { key: 'heading', syntax: '# Heading', common: true },
  { key: 'bold', syntax: '**Bold**', common: true },
  { key: 'italic', syntax: '*Italic*', common: true },
  { key: 'strikethrough', syntax: '~~Deleted~~', common: false },
  { key: 'link', syntax: '[Text](https://example.com)', common: true },
  { key: 'image', syntax: '![Alt text](image.png)', common: false },
  { key: 'inlineCode', syntax: '`const value = 1`', common: true },
  { key: 'codeBlock', syntax: '```ts\nconst value = 1\n```', common: false },
  { key: 'quote', syntax: '> Quote', common: true },
  { key: 'unorderedList', syntax: '- List item', common: true },
  { key: 'orderedList', syntax: '1. List item', common: false },
  { key: 'taskList', syntax: '- [x] Completed', common: false },
  { key: 'table', syntax: '| A | B |\n| - | - |\n| 1 | 2 |', common: false },
  { key: 'horizontalRule', syntax: '---', common: false },
  { key: 'lineBreak', syntax: 'First line  \nSecond line', common: false }
] as const

/** Union of the supported syntax example keys. */
export type MarkdownSyntaxKey = (typeof markdownSyntaxExamples)[number]['key']

/** Compact syntax rows used by the question-mark tooltip. */
export const commonMarkdownSyntaxExamples = markdownSyntaxExamples.filter((item) => item.common)

/** English fallback labels used when no i18n labels are supplied. */
export const defaultMarkdownEditorLabels: MarkdownEditorLabels = {
  splitMode: 'Split view',
  sourceMode: 'Source only',
  format: 'Format',
  help: 'Markdown syntax help',
  more: 'More',
  insertImage: 'Insert image',
  imageTooLarge: 'The selected image is too large for a local draft.',
  imageReadFailed: 'The image could not be read.',
  imageAlt: 'Image',
  editor: 'Markdown source',
  preview: 'Preview',
  emptyPreview: 'The preview will appear here as you type.',
  syntaxTitle: 'Markdown syntax',
  syntaxDescription: 'CommonMark and GitHub Flavored Markdown examples',
  syntax: {
    heading: 'Heading',
    bold: 'Bold',
    italic: 'Italic',
    strikethrough: 'Strikethrough',
    link: 'Link',
    image: 'Image',
    inlineCode: 'Inline code',
    codeBlock: 'Code block',
    quote: 'Quote',
    unorderedList: 'Unordered list',
    orderedList: 'Ordered list',
    taskList: 'Task list',
    table: 'Table',
    horizontalRule: 'Horizontal rule',
    lineBreak: 'Line break'
  }
}
