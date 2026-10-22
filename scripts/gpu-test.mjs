#!/usr/bin/env node
// Validate the WebGPU kernel on real hardware: starts Vite, opens the installed
// Google Chrome with WebGPU, and runs test/gpu/gpuCheck.ts in the page.
//
//   npm run test:gpu                         # default adapter
//   npm run test:gpu -- --adapter-luid=0,1234   # pick a GPU on Windows (LUIDs: chrome://gpu)
//   npm run test:gpu -- --swiftshader        # CPU-emulated WebGPU (no GPU needed; slow)
//   npm run test:gpu -- --headed             # watch it run
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const argv = process.argv.slice(2)
const flag = (name) => argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
const value = (name) => flag(name)?.split('=').slice(1).join('=')

const args = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist']
if (flag('swiftshader')) args.push('--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader')
if (value('adapter-luid')) args.push(`--use-adapter-luid=${value('adapter-luid')}`)

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await server.listen()
const url = server.resolvedUrls.local[0]

let browser
let exitCode = 1
try {
  browser = await chromium.launch({ channel: 'chrome', headless: !flag('headed'), args })
  const page = await browser.newPage()
  page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()) })
  await page.goto(url)
  const run = () => page.evaluate(async (opts) => {
    if (!navigator.gpu) return { unsupported: true }
    const { runGpuCheck } = await import('/test/gpu/gpuCheck.ts')
    return runGpuCheck(opts)
  }, { allowFallbackAdapter: !!flag('swiftshader'), seconds: Number(value('seconds') ?? 4) })
  let report
  try {
    report = await run()
  } catch (err) {
    // Vite may reload the page once while pre-bundling dependencies.
    if (!String(err).includes('Execution context was destroyed')) throw err
    await page.waitForLoadState('load')
    report = await run()
  }
  if (report.unsupported) {
    console.error('WebGPU is not available in this Chrome.')
  } else {
    console.log(`Adapters: ${report.adapters.join(', ')}`)
    console.log(JSON.stringify(report.details, null, 2))
    if (report.failures.length) {
      console.error('\nFAILED:\n  ' + report.failures.join('\n  '))
    } else {
      console.log('\nGPU kernel OK')
      exitCode = 0
    }
  }
} catch (err) {
  console.error(err)
} finally {
  await browser?.close()
  await server.close()
}
process.exit(exitCode)
