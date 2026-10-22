#!/usr/bin/env node
// Regenerate every icon and social-card image from source, rendered with the
// installed Google Chrome so the PNGs match what browsers draw.
//   src/assets/icon-small.svg -> favicon.svg, favicon-16x16.png, favicon-32x32.png
//   src/assets/icon.svg       -> apple-touch-icon.png, android-chrome-192/512.png
//   socialCard() below        -> og-image.png, twitter-card.png (1200 x 630)
//   npm run images
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const root = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const small = read('src/assets/icon-small.svg')
const full = read('src/assets/icon.svg')
// iOS masks home-screen icons itself; transparent rounded corners would show as black.
const fullBleed = full.replace('class="tile" width="64" height="64" rx="14"', 'class="tile" width="64" height="64" rx="0"')
if (fullBleed === full) throw new Error('icon.svg: tile rect not found')

const svgImg = (svg, size) =>
  `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block">`

// Social cards are laid out with HTML so nothing depends on guessed text widths.
function socialCard({ tagline, label, pre, mid, suf }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1200px; height: 630px; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif; color: #f0f1f5;
    background:
      radial-gradient(ellipse 70% 60% at 12% 0%, rgba(99, 126, 234, .32), transparent 60%),
      radial-gradient(ellipse 60% 50% at 100% 100%, rgba(74, 222, 128, .10), transparent 60%),
      #07080c;
    padding: 56px 72px; display: flex; flex-direction: column; justify-content: center; gap: 44px;
  }
  .brand { display: flex; align-items: center; gap: 30px; }
  .brand .icon { filter: drop-shadow(0 14px 34px rgba(99, 126, 234, .45)); }
  h1 { font-size: 76px; font-weight: 700; letter-spacing: -.025em; line-height: 1; }
  .tagline { margin-top: 14px; font-size: 30px; color: rgba(240, 241, 245, .7); }
  .result {
    padding: 26px 30px; border-radius: 20px;
    background: rgba(20, 22, 30, .85); border: 2px solid rgba(74, 222, 128, .55);
    box-shadow: 0 0 0 1px rgba(74, 222, 128, .15), 0 18px 50px rgba(74, 222, 128, .12);
  }
  .label { display: flex; justify-content: space-between; align-items: center; font-size: 19px;
    letter-spacing: .1em; text-transform: uppercase; color: rgba(240, 241, 245, .5); }
  .verified { letter-spacing: 0; text-transform: none; font-size: 19px; color: #4ade80;
    padding: 5px 14px; border-radius: 999px; background: rgba(74, 222, 128, .1); border: 1px solid rgba(74, 222, 128, .35); }
  .addr { margin-top: 12px; font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace; font-size: 41px;
    white-space: nowrap; color: rgba(240, 241, 245, .82); }
  .addr b { color: #4ade80; font-weight: 700; }
  .chips { display: flex; gap: 16px; }
  .chip { font-size: 24px; font-weight: 600; padding: 14px 22px; border-radius: 14px; white-space: nowrap;
    background: rgba(99, 126, 234, .1); border: 1px solid rgba(143, 167, 255, .35); color: #dfe5ff; }
</style></head><body>
  <div class="brand">
    <div class="icon">${svgImg(full, 132)}</div>
    <div><h1>Vanity ETH GPU</h1><div class="tagline">${tagline}</div></div>
  </div>
  <div class="result">
    <div class="label"><span>${label}</span><span class="verified">✓ Verified locally</span></div>
    <div class="addr">0x<b>${pre}</b>${mid}<b>${suf}</b></div>
  </div>
  <div class="chips">
    <span class="chip">WebGPU-accelerated</span>
    <span class="chip">Keys never leave your browser</span>
    <span class="chip">Wallet &amp; first-contract addresses</span>
  </div>
</body></html>`
}

writeFileSync(new URL('public/favicon.svg', root), small)

const page = (html, size) => ({ html, width: size[0], height: size[1] })
const icon = (svg, s) => page(`<style>html,body{margin:0;background:transparent}</style>${svgImg(svg, s)}`, [s, s])
const targets = [
  ['public/favicon-16x16.png', icon(small, 16)],
  ['public/favicon-32x32.png', icon(small, 32)],
  ['public/apple-touch-icon.png', icon(fullBleed, 180)],
  ['public/android-chrome-192x192.png', icon(full, 192)],
  ['public/android-chrome-512x512.png', icon(full, 512)],
  ['public/og-image.png', page(socialCard({
    tagline: 'Ethereum vanity addresses, generated on your GPU',
    label: 'Wallet address', pre: 'c0ffee', mid: '7d1a4b09e3f26c58a91d40b7e2c635', suf: 'beef',
  }), [1200, 630])],
  ['public/twitter-card.png', page(socialCard({
    tagline: 'Vanity wallets and contract addresses, in your browser',
    label: 'First contract address', pre: 'dead', mid: '5a03c9e81f47b2d6609ae31c84f7d2b5', suf: 'f00d',
  }), [1200, 630])],
]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const [file, { html, width, height }] of targets) {
    const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
    await tab.setContent(html)
    await tab.evaluate(() => Promise.all([...document.images].map(img => img.decode())).then(() => document.fonts.ready))
    writeFileSync(new URL(file, root), await tab.screenshot({ omitBackground: true }))
    await tab.close()
    console.log(`${file} (${width}x${height})`)
  }
} finally {
  await browser.close()
}
