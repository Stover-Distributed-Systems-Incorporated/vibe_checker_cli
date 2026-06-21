import {chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

export interface Credentials {
  access_token: string
  /** Epoch milliseconds at which the access token expires. */
  expires_at: number
  refresh_token: string
}

const FILE_NAME = 'credentials.json'

function credentialsPath(configDir: string): string {
  return join(configDir, FILE_NAME)
}

/**
 * Persist the session tokens to the user's config directory with owner-only
 * permissions (dir 0700, file 0600) so other local users can't read them.
 */
export async function saveCredentials(configDir: string, creds: Credentials): Promise<void> {
  await mkdir(configDir, {mode: 0o700, recursive: true})
  const file = credentialsPath(configDir)
  await writeFile(file, JSON.stringify(creds, null, 2), {mode: 0o600})
  // Re-assert perms in case the file already existed with looser permissions.
  await chmod(file, 0o600)
}

/** Load the stored session, or null if the user is not logged in. */
export async function loadCredentials(configDir: string): Promise<Credentials | null> {
  try {
    const raw = await readFile(credentialsPath(configDir), 'utf8')
    return JSON.parse(raw) as Credentials
  } catch {
    return null
  }
}

/** Remove the stored session (used by logout). */
export async function clearCredentials(configDir: string): Promise<void> {
  await rm(credentialsPath(configDir), {force: true})
}
