<script setup lang="ts">
import {
  commonMarkdownSyntaxExamples,
  defaultMarkdownEditorLabels,
  formatMarkdown,
  markdownSyntaxExamples,
  renderMarkdown,
  type MarkdownEditorLabels
} from '@renderer/utils/markdown'
import { resolveDraftImage, saveDraftImage } from '@renderer/utils/draft-image-storage'

interface Props {
  modelValue: string
  width?: string | number
  height?: string | number
  theme?: 'light' | 'dark'
  autosaveDelay?: number
  placeholder?: string
  maxImageSize?: number
  imageStorageKey?: string
  resolvePersistentImage?: (reference: string) => string | undefined
  labels?: Omit<Partial<MarkdownEditorLabels>, 'syntax'> & {
    syntax?: Partial<MarkdownEditorLabels['syntax']>
  }
}

const props = withDefaults(defineProps<Props>(), {
  width: '100%',
  height: 460,
  theme: 'light',
  autosaveDelay: 1000,
  placeholder: 'Write Markdown here…',
  maxImageSize: 1024 * 1024,
  imageStorageKey: undefined,
  labels: () => ({})
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'save', value: string): void
  (event: 'format', value: string): void
  (event: 'error', message: string): void
}>()

const draft = ref(props.modelValue)
const mode = ref<'split' | 'source'>('split')
const showSyntaxDialog = ref(false)
const textareaRef = ref<HTMLTextAreaElement>()
const imageInputRef = ref<HTMLInputElement>()
let saveTimer: ReturnType<typeof setTimeout> | undefined

const resolvedLabels = computed<MarkdownEditorLabels>(() => ({
  ...defaultMarkdownEditorLabels,
  ...props.labels,
  syntax: {
    ...defaultMarkdownEditorLabels.syntax,
    ...props.labels.syntax
  }
}))

// Draft and persisted images both use compact references; bytes stay outside Markdown.
const previewHtml = computed(() =>
  renderMarkdown(draft.value, (reference) => {
    if (reference.startsWith('draft-image://') && props.imageStorageKey) {
      return resolveDraftImage(props.imageStorageKey, reference)
    }
    if (reference.startsWith('diary-image://')) return props.resolvePersistentImage?.(reference)
    return undefined
  })
)
const hasPreview = computed(() => draft.value.trim().length > 0)
const normalizedDelay = computed(() => Math.max(0, Number(props.autosaveDelay) || 0))

function toCssSize(value: string | number): string {
  return typeof value === 'number' ? `${value}px` : value
}

const editorStyle = computed(() => ({
  '--markdown-editor-width': toCssSize(props.width),
  '--markdown-editor-height': toCssSize(props.height)
}))

/** Clear pending work whenever the draft source or component lifecycle changes. */
function cancelSave(): void {
  if (saveTimer === undefined) return
  clearTimeout(saveTimer)
  saveTimer = undefined
}

/** Emit the current draft only after the configured quiet period. */
function scheduleSave(value: string): void {
  cancelSave()
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    emit('save', value)
  }, normalizedDelay.value)
}

/** Keep v-model immediate while the persistence event remains debounced. */
function updateDraft(value: string): void {
  draft.value = value
  emit('update:modelValue', value)
  scheduleSave(value)
}

function handleInput(event: Event): void {
  updateDraft((event.target as HTMLTextAreaElement).value)
}

/** Apply markdownlint-compatible automatic fixes to the whole draft. */
function handleFormat(): void {
  const formatted = formatMarkdown(draft.value)
  updateDraft(formatted)
  emit('format', formatted)
}

/** Insert generated Markdown at the user's current caret position. */
async function insertAtSelection(markdown: string): Promise<void> {
  const textarea = textareaRef.value
  const start = textarea?.selectionStart ?? draft.value.length
  const end = textarea?.selectionEnd ?? start
  const nextValue = `${draft.value.slice(0, start)}${markdown}${draft.value.slice(end)}`

  updateDraft(nextValue)
  await nextTick()
  textareaRef.value?.focus()
  textareaRef.value?.setSelectionRange(start + markdown.length, start + markdown.length)
}

/** Store image bytes separately and insert only a compact reference at the caret. */
async function handleImageSelection(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  if (file.size > props.maxImageSize) {
    emit('error', resolvedLabels.value.imageTooLarge)
    return
  }

  try {
    if (!props.imageStorageKey) {
      throw new Error('An image storage key is required')
    }
    const reference = await saveDraftImage(props.imageStorageKey, file)
    const alt = file.name.replace(/\.[^.]+$/, '') || resolvedLabels.value.imageAlt
    await insertAtSelection(`![${alt}](${reference})`)
  } catch {
    emit('error', resolvedLabels.value.imageReadFailed)
  }
}

/** Preview links are display-only inside the Electron application. */
function handlePreviewInteraction(event: Event): void {
  const target = event.target as Element | null
  if (!target?.closest('a')) return
  event.preventDefault()
  event.stopPropagation()
}

// Parent resets (for example after form submission) must not trigger autosave again.
watch(
  () => props.modelValue,
  (value) => {
    if (value === draft.value) return
    cancelSave()
    draft.value = value
  }
)

watch(
  () => props.autosaveDelay,
  () => cancelSave()
)

onBeforeUnmount(cancelSave)
</script>

<template>
  <section
    class="markdown-editor"
    :data-theme="theme"
    :style="editorStyle"
    :aria-label="resolvedLabels.editor"
  >
    <header class="markdown-toolbar">
      <div class="mode-switch" role="group" :aria-label="resolvedLabels.editor">
        <button
          type="button"
          class="toolbar-button mode-button"
          :class="{ active: mode === 'split' }"
          :aria-pressed="mode === 'split'"
          @click="mode = 'split'"
        >
          <span class="i-ep-view" aria-hidden="true"></span>
          {{ resolvedLabels.splitMode }}
        </button>
        <button
          type="button"
          class="toolbar-button mode-button"
          :class="{ active: mode === 'source' }"
          :aria-pressed="mode === 'source'"
          @click="mode = 'source'"
        >
          <span class="i-ep-document" aria-hidden="true"></span>
          {{ resolvedLabels.sourceMode }}
        </button>
      </div>

      <div class="toolbar-actions">
        <el-tooltip placement="bottom-end" effect="light" :show-after="180" trigger="hover">
          <template #content>
            <div class="syntax-help">
              <strong>{{ resolvedLabels.syntaxTitle }}</strong>
              <dl>
                <template v-for="item in commonMarkdownSyntaxExamples" :key="item.key">
                  <dt>{{ resolvedLabels.syntax[item.key] }}</dt>
                  <dd>
                    <code>{{ item.syntax }}</code>
                  </dd>
                </template>
              </dl>
              <button type="button" class="syntax-more" @click="showSyntaxDialog = true">
                {{ resolvedLabels.more }}
                <span class="i-ep-arrow-right" aria-hidden="true"></span>
              </button>
            </div>
          </template>
          <button
            type="button"
            class="toolbar-button icon-button"
            :aria-label="resolvedLabels.help"
          >
            <span class="i-ep-question-filled" aria-hidden="true"></span>
          </button>
        </el-tooltip>

        <input
          ref="imageInputRef"
          class="visually-hidden"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          data-testid="image-input"
          @change="handleImageSelection"
        />
        <el-tooltip
          placement="bottom"
          effect="light"
          :show-after="180"
          :content="resolvedLabels.insertImage"
        >
          <button
            type="button"
            class="toolbar-button icon-button"
            :aria-label="resolvedLabels.insertImage"
            @click="imageInputRef?.click()"
          >
            <span class="i-ep-picture" aria-hidden="true"></span>
          </button>
        </el-tooltip>

        <button type="button" class="toolbar-button format-button" @click="handleFormat">
          <span class="i-ep-magic-stick" aria-hidden="true"></span>
          {{ resolvedLabels.format }}
        </button>
      </div>
    </header>

    <div class="editor-body" :class="{ 'source-only': mode === 'source' }">
      <div class="editor-pane">
        <div class="pane-label">{{ resolvedLabels.editor }}</div>
        <textarea
          ref="textareaRef"
          class="markdown-textarea"
          :value="draft"
          :placeholder="placeholder"
          :aria-label="resolvedLabels.editor"
          spellcheck="true"
          @input="handleInput"
        ></textarea>
      </div>

      <div v-if="mode === 'split'" class="preview-pane">
        <div class="pane-label">{{ resolvedLabels.preview }}</div>
        <div
          v-if="hasPreview"
          class="markdown-preview"
          data-testid="markdown-preview"
          @click="handlePreviewInteraction"
          @auxclick="handlePreviewInteraction"
          v-html="previewHtml"
        ></div>
        <div v-else class="preview-empty">{{ resolvedLabels.emptyPreview }}</div>
      </div>
    </div>
  </section>

  <el-dialog
    v-model="showSyntaxDialog"
    class="syntax-dialog"
    :title="resolvedLabels.syntaxTitle"
    width="min(720px, 92vw)"
    append-to-body
  >
    <p class="syntax-description">{{ resolvedLabels.syntaxDescription }}</p>
    <div class="syntax-reference">
      <div v-for="item in markdownSyntaxExamples" :key="item.key" class="syntax-row">
        <strong>{{ resolvedLabels.syntax[item.key] }}</strong>
        <pre><code>{{ item.syntax }}</code></pre>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.markdown-editor {
  --editor-bg: #fff;
  --editor-toolbar: #f7fbfa;
  --editor-panel: #fff;
  --editor-border: #dcebea;
  --editor-divider: #e8f1f0;
  --editor-text: #233e46;
  --editor-muted: #607780;
  --editor-code: #edf7f3;
  --editor-accent: #3974b6;
  --editor-active: #e1eefc;
  width: var(--markdown-editor-width);
  height: var(--markdown-editor-height);
  min-height: 300px;
  overflow: hidden;
  border: 1px solid var(--editor-border);
  border-radius: 20px;
  background: var(--editor-bg);
  color: var(--editor-text);
  box-shadow: 0 16px 40px -30px rgb(42 83 101 / 35%);
}

.markdown-editor[data-theme='dark'] {
  --editor-bg: #172329;
  --editor-toolbar: #1d2c32;
  --editor-panel: #172329;
  --editor-border: #36505a;
  --editor-divider: #2c424a;
  --editor-text: #e6f2ef;
  --editor-muted: #a5bbb9;
  --editor-code: #243940;
  --editor-accent: #91bdec;
  --editor-active: #28465d;
  color-scheme: dark;
}

.markdown-toolbar {
  display: flex;
  min-height: 56px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--editor-divider);
  background: var(--editor-toolbar);
}

.mode-switch,
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mode-switch {
  padding: 3px;
  border: 1px solid var(--editor-border);
  border-radius: 11px;
  background: var(--editor-panel);
}

.toolbar-button {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--editor-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}

.toolbar-button:hover,
.toolbar-button.active {
  background: var(--editor-active);
  color: var(--editor-accent);
}

.toolbar-button:focus-visible,
.markdown-textarea:focus-visible {
  outline: 3px solid #79a9df;
  outline-offset: 2px;
}

.mode-button,
.format-button {
  padding: 0 11px;
}

.icon-button {
  width: 34px;
  font-size: 17px;
}

.format-button {
  border: 1px solid var(--editor-border);
  background: var(--editor-panel);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.editor-body {
  display: grid;
  height: calc(100% - 56px);
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.editor-body.source-only {
  grid-template-columns: minmax(0, 1fr);
}

.editor-pane,
.preview-pane {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--editor-panel);
}

.editor-pane {
  border-right: 1px solid var(--editor-divider);
}

.source-only .editor-pane {
  border-right: 0;
}

.pane-label {
  flex-shrink: 0;
  padding: 9px 16px 7px;
  color: var(--editor-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.markdown-textarea {
  width: 100%;
  min-height: 0;
  flex: 1;
  resize: none;
  border: 0;
  outline: 0;
  padding: 10px 18px 20px;
  background: transparent;
  color: var(--editor-text);
  font-family: 'Cascadia Code', 'SFMono-Regular', Consolas, monospace;
  font-size: 13px;
  line-height: 1.75;
  tab-size: 2;
}

.markdown-textarea::placeholder {
  color: var(--editor-muted);
  opacity: 0.75;
}

.markdown-preview,
.preview-empty {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 10px 20px 24px;
}

.preview-empty {
  display: grid;
  place-items: center;
  color: var(--editor-muted);
  text-align: center;
}

.markdown-preview {
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.75;
}

.markdown-preview :deep(h1),
.markdown-preview :deep(h2),
.markdown-preview :deep(h3) {
  margin: 1.3em 0 0.55em;
  line-height: 1.3;
}

.markdown-preview :deep(h1:first-child),
.markdown-preview :deep(h2:first-child),
.markdown-preview :deep(h3:first-child),
.markdown-preview :deep(p:first-child) {
  margin-top: 0;
}

.markdown-preview :deep(h1) {
  padding-bottom: 0.35em;
  border-bottom: 1px solid var(--editor-divider);
  font-size: 1.65em;
}

.markdown-preview :deep(h2) {
  font-size: 1.35em;
}

.markdown-preview :deep(p),
.markdown-preview :deep(ul),
.markdown-preview :deep(ol),
.markdown-preview :deep(blockquote),
.markdown-preview :deep(pre),
.markdown-preview :deep(table) {
  margin: 0.8em 0;
}

.markdown-preview :deep(a) {
  color: var(--editor-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: not-allowed;
}

.markdown-preview :deep(blockquote) {
  padding: 0.2em 1em;
  border-left: 4px solid #6dc29c;
  color: var(--editor-muted);
}

.markdown-preview :deep(code) {
  padding: 0.15em 0.4em;
  border-radius: 5px;
  background: var(--editor-code);
  font-family: 'Cascadia Code', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.9em;
}

.markdown-preview :deep(pre) {
  overflow: auto;
  padding: 14px;
  border-radius: 10px;
  background: var(--editor-code);
}

.markdown-preview :deep(pre code) {
  padding: 0;
  background: transparent;
}

.markdown-preview :deep(table) {
  width: 100%;
  border-collapse: collapse;
}

.markdown-preview :deep(th),
.markdown-preview :deep(td) {
  padding: 7px 9px;
  border: 1px solid var(--editor-border);
  text-align: left;
}

.markdown-preview :deep(img) {
  display: block;
  max-width: 100%;
  max-height: 520px;
  margin: 1em auto;
  border-radius: 10px;
  object-fit: contain;
}

.syntax-help {
  min-width: 280px;
  color: #233e46;
}

.syntax-help dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  margin: 9px 0 0;
}

.syntax-help dt,
.syntax-help dd {
  margin: 0;
}

.syntax-help dt {
  color: #607780;
}

.syntax-help code,
.syntax-row code {
  color: #2d629e;
  font-family: 'Cascadia Code', Consolas, monospace;
}

.syntax-more {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 10px 0 0 auto;
  border: 0;
  background: transparent;
  color: #3974b6;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.syntax-description {
  margin: 0 0 16px;
  color: #607780;
  font-size: 13px;
}

.syntax-reference {
  display: grid;
  max-height: min(62vh, 560px);
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  overflow-y: auto;
}

.syntax-row {
  min-width: 0;
  padding: 12px;
  border: 1px solid #e3efee;
  border-radius: 10px;
  background: #f8fbfa;
}

.syntax-row strong {
  color: #233e46;
  font-size: 12px;
}

.syntax-row pre {
  overflow-x: auto;
  margin: 7px 0 0;
  white-space: pre-wrap;
}

@media (max-width: 720px) {
  .markdown-editor {
    min-height: 520px;
  }

  .markdown-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .mode-switch,
  .toolbar-actions {
    justify-content: space-between;
  }

  .editor-body {
    height: calc(100% - 104px);
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }

  .editor-body.source-only {
    grid-template-rows: minmax(0, 1fr);
  }

  .editor-pane {
    border-right: 0;
    border-bottom: 1px solid var(--editor-divider);
  }

  .source-only .editor-pane {
    border-bottom: 0;
  }

  .syntax-reference {
    grid-template-columns: 1fr;
  }
}
</style>
