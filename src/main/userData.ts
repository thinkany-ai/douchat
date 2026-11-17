export function applicationName(development: boolean): 'Douchat Dev' | 'Douchat' {
  return development ? 'Douchat Dev' : 'Douchat'
}

/**
 * Development may run a second, isolated profile (DOUCHAT_PROFILE=local gives
 * `douchat-dev-local`), e.g. against a local service, without sharing the
 * default dev profile's database, sync cursors or single-instance lock.
 * Packaged builds ignore the profile.
 */
export function userDataDirectoryName(development: boolean, profile?: string): string {
  if (!development) return 'douchat'
  const name = profile?.trim().toLowerCase()
  return name && /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) ? `douchat-dev-${name}` : 'douchat-dev'
}
