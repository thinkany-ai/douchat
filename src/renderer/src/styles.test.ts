import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('messenger surface theme styles', () => {
  it('keeps the late compact search rule theme-aware', () => {
    expect(styles).toContain('--search-surface: #36373c')
    expect(styles).toContain('--search-focus-surface: #3b3c42')
    expect(styles).toMatch(
      /\.messenger :is\(\.messenger-inbox, \.contacts-sidebar\) \.search-box \{[^}]*background: var\(--search-surface\)/s
    )
  })

  it('keeps the dark contacts header and list on one sidebar surface', () => {
    expect(styles).toContain(
      "[data-theme='dark'] .messenger .contact-list { background: var(--sidebar); color: var(--ink); }"
    )
    expect(styles).not.toMatch(
      /\[data-theme='dark'\] \.messenger :is\([^)]*\.contact-list[^)]*\) \{ background: var\(--canvas\)/
    )
  })

  it('records every chat row height so offscreen rows keep their real size', () => {
    expect(styles).toMatch(/\.timeline-item \{\s*contain-intrinsic-size: auto 120px;\s*\}/)
    expect(styles).toMatch(/\.timeline-item\[data-offscreen\] \{\s*content-visibility: auto;\s*\}/)
  })

  it('lets the contact profile use the same workspace background as chat', () => {
    expect(styles).toMatch(/\.messenger \.workspace \{\s*background: var\(--pane\);\s*\}/)
    expect(styles).not.toMatch(/\.messenger \.contact-profile-pane \{[^}]*background:/)
  })

  it('keeps every desktop dialog off the fragile Windows animation path', () => {
    expect(styles).toMatch(
      /html\[data-platform='win32'\] :is\(\.agent-modal, \.settings-modal, \.conversation-records-modal, \.social-group-dialog\) \{\s*animation: none;/s
    )
  })

  it('disables blur for both custom and native dialog backdrops on Windows', () => {
    expect(styles).toMatch(
      /html\[data-platform='win32'\] \.modal-backdrop \{[^}]*-webkit-backdrop-filter: none;[^}]*backdrop-filter: none;[^}]*animation: none;/s
    )
    expect(styles).toMatch(
      /html\[data-platform='win32'\] \.add-friend-modal::backdrop \{[^}]*-webkit-backdrop-filter: none;[^}]*backdrop-filter: none;/s
    )
  })

  it('aligns the credits refresh action with the right edge of the credits card', () => {
    expect(styles).toMatch(
      /\.settings-modal \.local-proxy-heading,\s*\.settings-modal \.usage-heading \{\s*padding-right: 0;/s
    )
  })
})
