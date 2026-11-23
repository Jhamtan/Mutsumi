<template>
  <router-view />
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

html {
  color-scheme: light;
  background: #f5f9f8;
}

body {
  font-family: 'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

h1,
h2,
p {
  margin: 0;
}

button,
input {
  font: inherit;
}

button,
a {
  -webkit-tap-highlight-color: transparent;
}

button:focus-visible,
a:focus-visible {
  outline: 3px solid #79a9df;
  outline-offset: 4px;
}

::selection {
  color: #233e46;
  background: #c5ebd6;
}

* {
  scrollbar-width: thin;
  scrollbar-color: #c5d9da transparent;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
</style>
