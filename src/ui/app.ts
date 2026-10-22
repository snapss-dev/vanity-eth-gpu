import { bytesToHex } from '../utils/hex'
import { createKeystoreV3 } from '../wallet/keystoreV3'
import { type PrivKey32 } from '../wallet/keys'
import { type SearchTarget } from '../searchTarget'
import { ADDRESS_NIBBLE_LENGTH, calculatePatternDifficulty, mergeAddressPattern } from '../searchPattern'
import { createSearchController, type Engine, type SearchRequest } from '../search/controller'
import { chanceFoundByNow, formatDuration, formatNumber, secondsForChance } from './format'
import iconSvg from '../assets/icon.svg?raw'

const DONATE_ADDRESS = '0x99999933F17A1339958d50b3f59740E5Ad48C74C'
const DEFAULT_SUBTITLE = 'Fast vanity address generator'
// The app icon (also the source of the PNG icons), inlined so it never pops in.
const LOGO_SVG = iconSvg
  .replace(/<!--[\s\S]*?-->\s*/g, '')
  .replace('<svg ', '<svg class="logo-mark" aria-hidden="true" focusable="false" ')

type Found = {
  priv: PrivKey32
  targetAddress: string
  walletAddress: string
  target: SearchTarget
  /** Revealed, copied or downloaded: the user has had a chance to keep it. */
  exported: boolean
}

function sanitizeHex(s: string): string {
  return s.trim().replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '').slice(0, ADDRESS_NIBBLE_LENGTH)
}

function targetPreviewLabel(target: SearchTarget): string {
  return target === 'first-contract' ? 'First Contract Address Preview' : 'Wallet Address Preview'
}

function targetResultLabel(target: SearchTarget): string {
  return target === 'first-contract' ? 'First Contract Address' : 'Wallet Address'
}

function engineText(engine: Engine): string {
  return engine.kind === 'gpu'
    ? `Running on ${engine.labels.length > 1 ? `${engine.labels.length} GPUs` : 'GPU'} · ${engine.labels.join(' + ')}`
    : `Running on CPU · ${engine.threads} thread${engine.threads === 1 ? '' : 's'}`
}

async function copyToClipboard(text: string, btn: HTMLButtonElement) {
  try {
    await navigator.clipboard.writeText(text)
    btn.textContent = 'Copied!'
    btn.classList.add('copied')
    setTimeout(() => {
      btn.textContent = 'Copy'
      btn.classList.remove('copied')
    }, 1500)
  } catch {
    btn.textContent = 'Failed'
    setTimeout(() => btn.textContent = 'Copy', 1500)
  }
}

export function initApp(root: HTMLDivElement) {
  root.innerHTML = `
    <div class="header">
      <div class="logo">${LOGO_SVG}</div>
      <h1 class="title">Vanity ETH GPU</h1>
      <div class="subtitle" id="subtitle" aria-live="polite">${DEFAULT_SUBTITLE}</div>
    </div>

    <main class="panel">
      <div class="preview" id="preview">
        <div class="preview-label" id="preview-label">Wallet Address Preview</div>
        <div class="preview-address" id="preview-addr"></div>
      </div>

      <div class="input-group">
        <div class="field">
          <label for="prefix">Prefix</label>
          <input type="text" id="prefix" placeholder="c0ffee" spellcheck="false" autocomplete="off" autocapitalize="off" maxlength="40" pattern="[0-9a-fA-F]*">
        </div>
        <div class="field">
          <label for="suffix">Suffix</label>
          <input type="text" id="suffix" placeholder="beef" spellcheck="false" autocomplete="off" autocapitalize="off" maxlength="40" pattern="[0-9a-fA-F]*">
        </div>
      </div>

      <div class="options">
        <div class="target-wrap">
          <div class="target-label" id="target-label">Target</div>
          <div class="target-toggle" role="radiogroup" aria-labelledby="target-label">
            <label class="target-option">
              <input type="radio" name="search-target" value="wallet" checked>
              <span>Wallet</span>
            </label>
            <label class="target-option">
              <input type="radio" name="search-target" value="first-contract">
              <span>First Contract</span>
            </label>
          </div>
        </div>
        <div class="case-wrap">
          <div class="target-label">Checksum</div>
          <div class="case-toggle">
            <label class="case-option">
              <input type="checkbox" id="case-sensitive">
              <span>Case-sensitive</span>
            </label>
          </div>
        </div>
      </div>

      <div class="helper-text" id="target-help">Wallet mode searches for an address controlled directly by the generated private key.</div>
      <div class="pattern-warning hidden" id="pattern-warning" role="status"></div>

      <button class="btn-generate" id="btn-generate">Generate</button>

      <div class="stats">
        <div class="stat">
          <div class="stat-label">Speed</div>
          <div class="stat-value" id="stat-speed">-</div>
        </div>
        <div class="stat">
          <div class="stat-label">Checked</div>
          <div class="stat-value" id="stat-checked">0</div>
        </div>
        <div class="stat">
          <div class="stat-label" id="stat-eta-label">Difficulty</div>
          <div class="stat-value" id="stat-eta">-</div>
        </div>
      </div>

      <div class="odds hidden" id="odds">
        <div class="odds-track" role="progressbar" aria-label="Chance a match has turned up" aria-valuemin="0" aria-valuemax="100" id="odds-track">
          <div class="odds-fill" id="odds-fill"></div>
        </div>
        <div class="odds-text" id="odds-text"></div>
      </div>

      <div class="result" id="result">
        <div class="verification-proof" id="verification-proof"></div>
        <div class="result-row">
          <div class="result-label" id="result-addr-label">Address</div>
          <div class="result-value" id="result-addr">
            <span id="addr-text"></span>
            <button class="copy-btn" id="copy-addr">Copy</button>
          </div>
        </div>
        <div class="result-row hidden" id="wallet-row">
          <div class="result-label">Deployer Wallet</div>
          <div class="result-value" id="result-wallet">
            <span id="wallet-text"></span>
            <button class="copy-btn" id="copy-wallet">Copy</button>
          </div>
        </div>
        <div class="result-row">
          <div class="result-label">Private Key</div>
          <div class="result-value" id="result-pk">
            <span id="pk-text"></span>
            <button class="copy-btn hidden" id="copy-pk">Copy</button>
          </div>
          <div class="copy-warning hidden" id="pk-warning">⚠ Anyone with this key controls all funds. Never paste it into a website or share it — clipboard contents can be read by other apps.</div>
        </div>
        <div class="actions">
          <button class="btn" id="btn-reveal">Reveal Key</button>
          <button class="btn btn-primary" id="btn-download">Download Keystore</button>
        </div>
        <div class="security-note">
          <strong>Before funding this address:</strong>
          <ul>
            <li>Verify the full address character-by-character.</li>
            <li>Reveal &amp; back up the private key or keystore offline.</li>
            <li>Send a tiny test amount first and confirm you control it.</li>
          </ul>
        </div>
      </div>
    </main>

    <footer class="footer">
      <div>All computations run locally in your browser. For maximum security, disconnect from the internet before generating.</div>
      <div class="built-by">Built by <a href="https://x.com/snapss" target="_blank" rel="noopener">@snapss</a> & <a href="https://claude.ai" target="_blank" rel="noopener">Claude</a></div>
      <div class="open-source"><a href="https://github.com/HODL-Community/vanity-eth-gpu" target="_blank" rel="noopener">Open Source</a> on GitHub</div>
      <div class="donate">Donate: <span class="donate-addr">${DONATE_ADDRESS}</span><button class="copy-btn-small" id="copy-donate">Copy</button></div>
    </footer>

    <div class="modal-overlay" id="pw-modal" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="pw-modal-title">
        <div class="modal-title" id="pw-modal-title">Encrypt Keystore</div>
        <div class="modal-desc">Choose a password to encrypt your private key. You'll need this exact password to import the keystore — there is no recovery if you lose it.</div>
        <input type="password" id="pw-input" class="modal-input" placeholder="Password (min 8 characters)" autocomplete="new-password" spellcheck="false" aria-label="Password">
        <input type="password" id="pw-confirm" class="modal-input" placeholder="Confirm password" autocomplete="new-password" spellcheck="false" aria-label="Confirm password">
        <div class="modal-error" id="pw-error" aria-live="polite"></div>
        <div class="modal-actions">
          <button class="btn" id="pw-cancel">Cancel</button>
          <button class="btn btn-primary" id="pw-ok">Encrypt &amp; Download</button>
        </div>
      </div>
    </div>
  `

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!

  const prefixInput = $<HTMLInputElement>('prefix')
  const suffixInput = $<HTMLInputElement>('suffix')
  const searchTargetInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="search-target"]'))
  const caseSensitive = $<HTMLInputElement>('case-sensitive')
  const previewEl = $<HTMLDivElement>('preview')
  const previewLabel = $<HTMLDivElement>('preview-label')
  const previewAddr = $<HTMLDivElement>('preview-addr')
  const btnGenerate = $<HTMLButtonElement>('btn-generate')
  const statSpeed = $<HTMLDivElement>('stat-speed')
  const statChecked = $<HTMLDivElement>('stat-checked')
  const statEtaLabel = $<HTMLDivElement>('stat-eta-label')
  const statEta = $<HTMLDivElement>('stat-eta')
  const odds = $<HTMLDivElement>('odds')
  const oddsTrack = $<HTMLDivElement>('odds-track')
  const oddsFill = $<HTMLDivElement>('odds-fill')
  const oddsText = $<HTMLDivElement>('odds-text')
  const resultEl = $<HTMLDivElement>('result')
  const resultAddrLabel = $<HTMLDivElement>('result-addr-label')
  const addrText = $<HTMLSpanElement>('addr-text')
  const walletRow = $<HTMLDivElement>('wallet-row')
  const walletText = $<HTMLSpanElement>('wallet-text')
  const pkText = $<HTMLSpanElement>('pk-text')
  const pkWarning = $<HTMLDivElement>('pk-warning')
  const copyAddr = $<HTMLButtonElement>('copy-addr')
  const copyWallet = $<HTMLButtonElement>('copy-wallet')
  const copyPk = $<HTMLButtonElement>('copy-pk')
  const btnReveal = $<HTMLButtonElement>('btn-reveal')
  const btnDownload = $<HTMLButtonElement>('btn-download')
  const subtitleEl = $<HTMLDivElement>('subtitle')
  const targetHelp = $<HTMLDivElement>('target-help')
  const patternWarning = $<HTMLDivElement>('pattern-warning')
  const verificationProof = $<HTMLDivElement>('verification-proof')

  const controller = createSearchController()

  let found: Found | null = null
  let keyRevealed = false

  // Live stats while running. Speed is measured over a sliding ~2 s window.
  let run: { request: SearchRequest; difficulty: number; checked: number; samples: Array<[number, number]> } | null = null
  let lastSpeed = 0

  // ── Helpers ──

  function selectedTarget(): SearchTarget {
    const checked = searchTargetInputs.find(input => input.checked)
    return checked?.value === 'first-contract' ? 'first-contract' : 'wallet'
  }

  function currentRequest(): SearchRequest {
    return {
      prefix: sanitizeHex(prefixInput.value),
      suffix: sanitizeHex(suffixInput.value),
      caseSensitive: caseSensitive.checked,
      target: selectedTarget(),
    }
  }

  function setInputsDisabled(disabled: boolean) {
    prefixInput.disabled = disabled
    suffixInput.disabled = disabled
    for (const input of searchTargetInputs) input.disabled = disabled
    caseSensitive.disabled = disabled
  }

  function showWarning(text: string | null) {
    patternWarning.textContent = text ?? ''
    patternWarning.classList.toggle('hidden', !text)
  }

  // Deterministic noise based on position (looks random but stable)
  const noiseChars = '7a3f8c2e9b1d5046'
  function generateNoise(len: number, offset: number): string {
    let result = ''
    for (let i = 0; i < len; i++) result += noiseChars[(i + offset * 7) % noiseChars.length]
    return result
  }

  function renderPreviewAddress(pattern: ReturnType<typeof mergeAddressPattern>) {
    previewAddr.replaceChildren(document.createTextNode('0x'))
    if (pattern.constrainedNibbles === 0 || !pattern.valid) {
      previewAddr.append(document.createTextNode(generateNoise(ADDRESS_NIBBLE_LENGTH, 0)))
      return
    }
    let noiseOffset = 0
    for (let i = 0; i < ADDRESS_NIBBLE_LENGTH; i++) {
      const known = pattern.body[i]
      if (known === null) {
        previewAddr.append(document.createTextNode(generateNoise(1, noiseOffset++)))
      } else {
        const span = document.createElement('span')
        span.className = 'match'
        span.textContent = known
        previewAddr.append(span)
      }
    }
  }

  /** Re-render everything derived from the inputs while idle. */
  function updatePreview() {
    const req = currentRequest()
    previewLabel.textContent = targetPreviewLabel(req.target)
    targetHelp.textContent = req.target === 'first-contract'
      ? 'First-contract mode targets the first CREATE address at nonce 0. Use the deployer before any other outgoing transaction.'
      : 'Wallet mode searches for an address controlled directly by the generated private key.'

    const pattern = mergeAddressPattern(req.prefix, req.suffix, req.caseSensitive)
    renderPreviewAddress(pattern)
    const empty = req.prefix.length + req.suffix.length === 0

    if (!pattern.valid) showWarning(pattern.message || 'This prefix/suffix request is impossible.')
    else if (empty) showWarning('Enter a hex prefix or suffix to start.')
    else showWarning(null)

    if (run) return // the running search owns the button and stats
    btnGenerate.disabled = !pattern.valid || empty

    const difficulty = calculatePatternDifficulty(req.prefix, req.suffix, req.caseSensitive)
    statEtaLabel.textContent = 'Difficulty'
    statEta.title = ''
    if (!pattern.valid) {
      statEta.textContent = 'Impossible'
    } else if (empty) {
      statEta.textContent = '-'
    } else {
      statEta.textContent = `1 in ${formatNumber(difficulty)}`
      if (lastSpeed > 0) statEta.title = `About ${formatDuration(secondsForChance(difficulty, lastSpeed, 0.5))} for a 50% chance at the last measured speed`
    }
  }

  function currentSpeed(): number {
    if (!run || run.samples.length < 2) return 0
    const [t0, c0] = run.samples[0]
    const [t1, c1] = run.samples[run.samples.length - 1]
    return t1 > t0 ? ((c1 - c0) * 1000) / (t1 - t0) : 0
  }

  function updateRunningStats() {
    if (!run) return
    const now = performance.now()
    run.samples.push([now, run.checked])
    while (run.samples.length > 2 && now - run.samples[0][0] > 2000) run.samples.shift()
    const speed = currentSpeed()
    if (speed > 0) lastSpeed = speed
    statSpeed.textContent = speed > 0 ? formatNumber(speed) + '/s' : '…'
    statChecked.textContent = formatNumber(run.checked)
    statEtaLabel.textContent = 'Est. Time'
    statEta.textContent = speed > 0 ? '~' + formatDuration(secondsForChance(run.difficulty, speed, 0.5)) : '…'
    statEta.title = 'Time for a 50% chance of a match. Each key is an independent draw, so this is a typical time, not a deadline.'

    const pct = Math.min(100, chanceFoundByNow(run.difficulty, run.checked) * 100)
    odds.classList.remove('hidden')
    oddsFill.style.width = `${pct}%`
    oddsTrack.setAttribute('aria-valuenow', String(Math.round(pct)))
    const p90 = speed > 0 ? ` · 90% by ~${formatDuration(secondsForChance(run.difficulty, speed, 0.9))}` : ''
    oddsText.textContent = `${pct < 1 ? '<1' : Math.round(pct)}% chance a match would have turned up by now${p90}`
  }

  // ── Found result ──

  function maskKey() {
    keyRevealed = false
    pkText.textContent = '•'.repeat(64)
    copyPk.classList.add('hidden')
    pkWarning.classList.add('hidden')
    btnReveal.textContent = 'Reveal Key'
  }

  function renderAddress(address: string, prefixLen: number, suffixLen: number) {
    const body = address.slice(2)
    const highlight = (text: string) => {
      const span = document.createElement('span')
      span.className = 'highlight'
      span.textContent = text
      return span
    }
    addrText.replaceChildren(
      '0x',
      highlight(body.slice(0, prefixLen)),
      body.slice(prefixLen, ADDRESS_NIBBLE_LENGTH - suffixLen),
      highlight(body.slice(ADDRESS_NIBBLE_LENGTH - suffixLen)),
    )
  }

  function showFound(req: SearchRequest, result: { priv: PrivKey32; targetAddress: string; walletAddress: string }) {
    found = { ...result, target: req.target, exported: false }
    resultAddrLabel.textContent = targetResultLabel(req.target)
    verificationProof.textContent = req.target === 'first-contract'
      ? 'Verified locally: this private key derives to the deployer wallet, and its first CREATE nonce-0 contract address matches this result.'
      : 'Verified locally: this private key derives to the displayed wallet address.'
    renderAddress(result.targetAddress, req.prefix.length, req.suffix.length)
    walletText.textContent = result.walletAddress
    walletRow.classList.toggle('hidden', req.target !== 'first-contract')
    maskKey() // the private key stays hidden until the user explicitly reveals it
    resultEl.classList.add('visible', 'found')
    // On small screens the result lands below the fold.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    resultEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' })
  }

  function clearFound() {
    found = null
    maskKey()
    resultEl.classList.remove('visible', 'found')
    walletRow.classList.add('hidden')
    walletText.textContent = ''
  }

  // ── Search ──

  function onEngine(engine: Engine, note?: string) {
    let text = engineText(engine)
    if (engine.kind === 'cpu') {
      if (controller.gpuStatus === 'preparing') text += ' · getting the GPU ready…'
      else if (controller.gpuUnavailableReason && !note) text += ' · WebGPU unavailable'
    }
    subtitleEl.textContent = text
    if (note) showWarning(note)
  }

  async function startSearch() {
    if (run || controller.running) return
    const req = currentRequest()
    const pattern = mergeAddressPattern(req.prefix, req.suffix, req.caseSensitive)
    if (!pattern.valid || req.prefix.length + req.suffix.length === 0) return

    if (found && !found.exported) {
      const ok = window.confirm(
        `You haven't revealed, copied or downloaded the private key for ${found.targetAddress} yet.\n\n` +
        'Start a new search and discard it? It cannot be recovered.')
      if (!ok) return
    }

    clearFound()
    const current = run = {
      request: req,
      difficulty: calculatePatternDifficulty(req.prefix, req.suffix, req.caseSensitive),
      checked: 0,
      samples: [] as Array<[number, number]>,
    }
    setInputsDisabled(true)
    btnGenerate.textContent = 'Stop'
    btnGenerate.classList.add('running')
    btnGenerate.disabled = false
    previewEl.classList.add('generating')
    showWarning(null)
    subtitleEl.textContent = 'Starting…'
    updateRunningStats()
    const ticker = setInterval(updateRunningStats, 250)

    let outcome: Awaited<ReturnType<typeof controller.search>> | null = null
    try {
      outcome = await controller.search(req, {
        onEngine,
        onProgress: (checked) => { current.checked = checked },
      })
      current.checked = outcome.checked
      updateRunningStats()
      subtitleEl.textContent = DEFAULT_SUBTITLE
    } catch (err) {
      // Any unexpected failure must not strand the UI in a disabled 'running' state.
      console.error('[vanity] search failed', err)
      subtitleEl.textContent = 'Something went wrong during the search — please reload the page.'
    } finally {
      clearInterval(ticker)
      run = null
      odds.classList.add('hidden')
      setInputsDisabled(false)
      btnGenerate.textContent = 'Generate'
      btnGenerate.classList.remove('running')
      previewEl.classList.remove('generating')
      updatePreview()
    }

    // After updatePreview(), which resets the stats to the idle view.
    if (outcome?.status === 'found') {
      showFound(req, outcome.result)
      statEtaLabel.textContent = 'Found In'
      statEta.textContent = formatDuration(outcome.seconds)
      statEta.title = ''
      statChecked.textContent = formatNumber(outcome.checked)
    }
  }

  // Start building the GPU kernel as soon as the user shows intent, so it is
  // usually ready by the time they press Generate.
  let warmed = false
  function warmUp() {
    if (warmed) return
    warmed = true
    void controller.prepareGpu()
  }

  // ── Events ──

  for (const input of [prefixInput, suffixInput]) {
    input.addEventListener('input', () => {
      const clean = sanitizeHex(input.value)
      if (clean !== input.value) input.value = clean
      updatePreview()
    })
    input.addEventListener('focus', warmUp)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void startSearch()
      }
    })
  }
  btnGenerate.addEventListener('pointerenter', warmUp)

  for (const input of searchTargetInputs) input.addEventListener('change', updatePreview)
  caseSensitive.addEventListener('change', updatePreview)

  btnGenerate.addEventListener('click', () => {
    if (run) controller.stop()
    else void startSearch()
  })

  btnReveal.addEventListener('click', () => {
    if (!found) return
    if (keyRevealed) { maskKey(); return }
    keyRevealed = true
    found.exported = true
    pkText.textContent = bytesToHex(found.priv)
    copyPk.classList.remove('hidden')
    pkWarning.classList.remove('hidden')
    btnReveal.textContent = 'Hide Key'
  })

  // Re-mask a revealed key when the page loses focus / is hidden, so it isn't
  // left exposed over the shoulder or in a background tab.
  window.addEventListener('blur', () => { if (keyRevealed) maskKey() })
  document.addEventListener('visibilitychange', () => { if (document.hidden && keyRevealed) maskKey() })

  // A found key exists only in this tab: warn before it's closed unsaved.
  window.addEventListener('beforeunload', (e) => {
    if (found && !found.exported) {
      e.preventDefault()
      e.returnValue = '' // older Safari / Chrome < 119 only prompt when this is set
    }
  })

  copyAddr.addEventListener('click', () => {
    if (found) void copyToClipboard(found.targetAddress, copyAddr)
  })

  copyWallet.addEventListener('click', () => {
    if (found) void copyToClipboard(found.walletAddress, copyWallet)
  })

  copyPk.addEventListener('click', () => {
    if (found && keyRevealed) void copyToClipboard(bytesToHex(found.priv), copyPk)
  })

  // Password modal — replaces a bare prompt() so a typo can't silently produce an
  // undecryptable keystore (which would be permanent fund loss).
  const pwModal = $<HTMLDivElement>('pw-modal')
  const pwInput = $<HTMLInputElement>('pw-input')
  const pwConfirm = $<HTMLInputElement>('pw-confirm')
  const pwError = $<HTMLDivElement>('pw-error')
  const pwOk = $<HTMLButtonElement>('pw-ok')
  const pwCancel = $<HTMLButtonElement>('pw-cancel')

  function promptPassword(): Promise<string | null> {
    return new Promise((resolve) => {
      const opener = document.activeElement as HTMLElement | null
      pwInput.value = ''
      pwConfirm.value = ''
      pwError.textContent = ''
      pwModal.hidden = false
      pwInput.focus()

      const cleanup = () => {
        pwModal.hidden = true
        pwInput.value = ''
        pwConfirm.value = ''
        pwOk.removeEventListener('click', onOk)
        pwCancel.removeEventListener('click', onCancel)
        pwModal.removeEventListener('keydown', onKey)
        pwModal.removeEventListener('mousedown', onBackdrop)
        opener?.focus()
      }
      const onOk = () => {
        const p = pwInput.value
        if (p.length < 8) { pwError.textContent = 'Password must be at least 8 characters.'; pwInput.focus(); return }
        if (p !== pwConfirm.value) { pwError.textContent = 'Passwords do not match.'; pwConfirm.focus(); return }
        cleanup(); resolve(p)
      }
      const onCancel = () => { cleanup(); resolve(null) }
      const onKey = (e: KeyboardEvent) => {
        // Keep keys inside the dialog from reaching page-level handlers.
        e.stopPropagation()
        // Enter submits from the password fields; on a focused button it
        // activates that button (so Enter on Cancel cancels).
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) { e.preventDefault(); onOk() }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        else if (e.key === 'Tab') {
          // Trap focus within the dialog.
          const focusable = [pwInput, pwConfirm, pwCancel, pwOk]
          const i = focusable.indexOf(document.activeElement as HTMLInputElement & HTMLButtonElement)
          const next = e.shiftKey ? (i <= 0 ? focusable.length - 1 : i - 1) : (i + 1) % focusable.length
          e.preventDefault()
          focusable[next].focus()
        }
      }
      const onBackdrop = (e: MouseEvent) => { if (e.target === pwModal) onCancel() }

      pwOk.addEventListener('click', onOk)
      pwCancel.addEventListener('click', onCancel)
      pwModal.addEventListener('keydown', onKey)
      pwModal.addEventListener('mousedown', onBackdrop)
    })
  }

  btnDownload.addEventListener('click', async () => {
    const current = found
    if (!current) return
    const password = await promptPassword()
    if (!password || found !== current) return

    const prevText = btnDownload.textContent
    btnDownload.disabled = true
    btnDownload.textContent = 'Encrypting…'
    try {
      const ks = await createKeystoreV3(current.priv, password)
      const blob = new Blob([JSON.stringify(ks, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${current.walletAddress}.json`
      a.click()
      // Some browsers drop the download if the URL is revoked too soon.
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
      current.exported = true
    } catch (err) {
      console.error('[vanity] keystore export failed', err)
      showWarning('Could not create the keystore file. Your key is still shown above — try again or reveal it.')
    } finally {
      btnDownload.disabled = false
      btnDownload.textContent = prevText
    }
  })

  const copyDonate = $<HTMLButtonElement>('copy-donate')
  copyDonate.addEventListener('click', () => {
    void copyToClipboard(DONATE_ADDRESS, copyDonate)
  })

  // Initialize
  maskKey()
  updatePreview()
}
