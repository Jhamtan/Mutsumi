/**
 * Web wallpaper template for photo wall export: generates the index.html /
 * style.css / wallpaper.js content required by a Wallpaper Engine web
 * wallpaper, plus a data URL decoding helper that turns photo wall data into
 * a standalone wallpaper project.
 */

import { PHOTOWALL_PORTRAIT_MAX_BYTES } from '@common/photowall'
import { parseImageDataUrl } from './image-validation'

/** Parses a data URL into MIME type, extension and binary content; returns null when invalid. */
export function parseDataUrl(dataUrl: string): {
  mimeType: string
  extension: string
  buffer: Buffer
} | null {
  try {
    const image = parseImageDataUrl(dataUrl, PHOTOWALL_PORTRAIT_MAX_BYTES)
    const extension =
      image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.slice('image/'.length)
    return { mimeType: image.mimeType, extension, buffer: image.bytes }
  } catch {
    return null
  }
}

/** Generates the main HTML. */
export function buildIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>照片墙 Photo Wall</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="wall">
    <div id="track"></div>
  </div>
  <img id="portrait" class="portrait" alt="" style="display:none">
  <script src="wallpaper.js"></script>
</body>
</html>
`
}

/** Generates the stylesheet. */
export function buildStyleCss(rounded = false): string {
  const radius = rounded ? '8px' : '0px'
  return `* {
  margin: 0;
  padding: 0;
  border: 0;
  box-sizing: border-box;
}

html,
body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: #0f1b2d;
}

:root {
  --wall-radius: ${radius};
}

#wall {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

#track {
  display: flex;
  gap: 4px;
  height: 100%;
  padding: 4px;
}

.column {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--wall-radius);
}

.column-inner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  animation-name: wall-scroll;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

.column-inner img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--wall-radius);
}

@keyframes wall-scroll {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(-50%);
  }
}

.portrait {
  position: fixed;
  left: 50%;
  bottom: 0;
  z-index: 10;
  height: auto;
  max-height: 97vh;
  max-width: 50vw;
  width: auto;
  object-fit: contain;
  transform: translate(-50%, 0);
  pointer-events: none;
  filter: drop-shadow(0 12px 40px rgba(0, 0, 0, 0.45));
}
`
}

/**
 * Generates the wallpaper script: injects the photo file names and portrait
 * file name, implements seamless multi-column upward scrolling, and responds
 * to Wallpaper Engine's "scroll speed" property. The portrait image stays
 * pinned to the bottom.
 */
export function buildWallpaperJs(images: string[], portrait: string | null): string {
  const imagesJson = JSON.stringify(images)
  const portraitJson = JSON.stringify(portrait)
  return `(function () {
  'use strict';

  var IMAGES = ${imagesJson};
  var PORTRAIT = ${portraitJson};

  var params = { speed: 30 };
  var track = document.getElementById('track');
  var portraitEl = document.getElementById('portrait');

  function repeatTo(list, min) {
    if (!list.length) return [];
    var out = [];
    while (out.length < min) out = out.concat(list);
    return out;
  }

  function build() {
    if (!IMAGES.length) return;
    var count = 5;
    var columns = [];
    for (var i = 0; i < count; i++) columns.push([]);
    IMAGES.forEach(function (src, index) {
      columns[index % count].push(src);
    });

    track.innerHTML = '';
    columns.forEach(function (list) {
      if (!list.length) return;
      var column = document.createElement('div');
      column.className = 'column';
      var inner = document.createElement('div');
      inner.className = 'column-inner';
      // Images keep their natural aspect ratio; duplicate once for a seamless loop (both halves must have equal height).
      var items = repeatTo(list, 8);
      items.concat(items).forEach(function (src) {
        var img = document.createElement('img');
        img.src = src;
        inner.appendChild(img);
      });
      column.appendChild(inner);
      track.appendChild(column);
    });
    applySpeed(params.speed);
  }

  function applySpeed(speed) {
    var inners = track.querySelectorAll('.column-inner');
    for (var i = 0; i < inners.length; i++) {
      inners[i].style.animationDuration = speed * 2 + 's';
      inners[i].style.animationPlayState = speed === 0 ? 'paused' : 'running';
    }
  }

  function initPortrait() {
    if (PORTRAIT) {
      portraitEl.src = PORTRAIT;
      portraitEl.style.display = '';
    }
  }

  window.wallpaperPropertyListener = {
    applyUserProperties: function (properties) {
      if (properties.speed) {
        params.speed = parseInt(properties.speed.value, 10);
        applySpeed(params.speed);
      }
    }
  };

  window.addEventListener('resize', build);
  initPortrait();
  build();
})();
`
}
