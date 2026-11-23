/**
 * Locale-aware date/time formatting for diary cards and pages. All timestamps
 * from the backend are ISO strings; invalid values render as an empty string.
 */
export type AppLocale = 'zh' | 'en'

function localeTag(locale: AppLocale): string {
  return locale === 'zh' ? 'zh-CN' : 'en'
}

/** Short date + time, e.g. "2026/11/07 09:30". */
export function formatDateTime(iso: string, locale: AppLocale): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

/** Long date only, e.g. "November 7, 2026" (zh-CN uses the localized Chinese long-date format). */
export function formatDate(iso: string, locale: AppLocale): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date)
}
