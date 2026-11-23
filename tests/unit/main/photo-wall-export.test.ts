import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  buildIndexHtml,
  buildStyleCss,
  buildWallpaperJs,
  parseDataUrl
} from '../../../src/main/services/photo-wall-export'

/**
 * Tests the wallpaper export template helpers: data-URL parsing and the
 * generated HTML/CSS/JS content.
 */
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC'
// The legacy fixture has malformed JPEG segment lengths and must remain rejected.
const corruptJpeg =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z'

describe('parseDataUrl', () => {
  it('parses a real JPEG into MIME, extension and bytes', async () => {
    const jpeg = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 120, g: 50, b: 40 } }
    })
      .jpeg()
      .toBuffer()
    const result = parseDataUrl(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
    try {
      expect(result).not.toBeNull()
      expect(result!.mimeType).toBe('image/jpeg')
      expect(result!.extension).toBe('jpg')
      expect(result!.buffer.equals(jpeg)).toBe(true)
    } finally {
      result?.buffer.fill(0)
      jpeg.fill(0)
    }
  })

  it('maps a real PNG extension correctly', () => {
    const result = parseDataUrl(`data:image/png;base64,${png}`)!
    expect(result.extension).toBe('png')
    expect(result.buffer.equals(Buffer.from(png, 'base64'))).toBe(true)
    result.buffer.fill(0)
  })

  it.each([
    '',
    'not-a-data-url',
    'data:text/plain;base64,QUJD',
    'data:image/jpeg;base64,QUJD',
    `data:image/jpeg;base64,${corruptJpeg}`,
    'data:image/png;base64,A===',
    'data:image/png;base64,AAAA\n'
  ])('rejects an invalid data URL: %j', (value) => {
    expect(parseDataUrl(value)).toBeNull()
  })
})

describe('generated wallpaper files', () => {
  it('builds a self-contained index.html', () => {
    const html = buildIndexHtml()
    expect(html).toContain('style.css')
    expect(html).toContain('wallpaper.js')
    expect(html).toContain('id="track"')
    expect(html).toContain('id="portrait"')
  })

  it('builds a stylesheet with scroll animation and a bottom-anchored portrait', () => {
    const css = buildStyleCss()
    expect(css).toContain('@keyframes wall-scroll')
    expect(css).toContain('.portrait')
    expect(css).toContain('bottom: 0')
    expect(css).toContain('--wall-radius: 0px')
  })

  it('enables rounded corners only when requested', () => {
    expect(buildStyleCss(true)).toContain('--wall-radius: 8px')
    expect(buildStyleCss(false)).toContain('--wall-radius: 0px')
  })

  it('injects image list and portrait into the script', () => {
    const js = buildWallpaperJs(['images/photo_000.jpg'], 'images/portrait.png')
    expect(js).toContain('images/photo_000.jpg')
    expect(js).toContain('images/portrait.png')
    expect(js).toContain('wallpaperPropertyListener')
  })
})
