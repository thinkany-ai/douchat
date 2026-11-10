/**
 * The douchat-host install command: `curl -fsSL <service>/h/<code> | sh`.
 * The service answers with the install token for that one-time code and runs
 * the regular install.sh (douchat-tanstack `hostInstallScript`).
 */
export const INSTALL_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export function hostInstallCommand(serviceUrl: string, code: string): string {
  if (!INSTALL_CODE.test(code)) throw new Error('The Douchat service returned an invalid install ticket.')
  const service = new URL(serviceUrl)
  // A local service is reached directly even where a proxy is configured.
  const local = LOOPBACK.has(service.hostname)
  if (service.protocol !== 'https:' && !local) throw new Error('The Douchat service must use HTTPS.')
  // An origin and a code from a fixed alphabet: nothing the shell would interpret.
  return `curl -fsSL${local ? " --noproxy '*'" : ''} ${service.origin}/h/${code} | sh`
}
