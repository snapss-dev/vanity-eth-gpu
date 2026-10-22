#!/usr/bin/env node
// Regenerate every favicon / app icon from the two SVG sources:
//   src/assets/icon-small.svg  -> favicon.svg, favicon-16x16.png, favicon-32x32.png
//   src/assets/icon.svg        -> apple-touch-icon.png, android-chrome-192/512.png
// Rasterized with the installed Google Chrome so PNGs match what browsers draw.
//   npm run icons
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const root = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const small = read('src/assets/icon-small.svg')
const full = read('src/assets/icon.svg')
// iOS masks home-screen icons itself; transparent rounded corners would show as black.
const fullBleed = full.replace('class="tile" width="64" height="64" rx="14"', 'class="tile" width="64" height="64" rx="0"')
if (fullBleed === full) throw new Error('icon.svg: tile rect not found')

writeFileSync(new URL('public/favicon.svg', root), small)

const targets = [
  ['public/favicon-16x16.png', small, 16],
  ['public/favicon-32x32.png', small, 32],
  ['public/apple-touch-icon.png', fullBleed, 180],
  ['public/android-chrome-192x192.png', full, 192],
  ['public/android-chrome-512x512.png', full, 512],
]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const [file, svg, size] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="${src}" width="${size}" height="${size}" style="display:block">`)
    await page.locator('img').evaluate(img => img.decode())
    writeFileSync(new URL(file, root), await page.screenshot({ omitBackground: true }))
    await page.close()
    console.log(`${file} (${size}px)`)
  }
} finally {
  await browser.close()
}
