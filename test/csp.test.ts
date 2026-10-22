import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CONTENT_SECURITY_POLICY_HEADER } from '../vite.config'

describe('Content Security Policy', () => {
  it('vercel.json sends the same policy as the build (the header is what covers workers)', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
    const header = vercel.headers[0].headers.find((h: { key: string }) => h.key === 'Content-Security-Policy')
    expect(header.value).toBe(CONTENT_SECURITY_POLICY_HEADER)
  })

  it('forbids network connections', () => {
    expect(CONTENT_SECURITY_POLICY_HEADER).toContain("connect-src 'none'")
  })
})
