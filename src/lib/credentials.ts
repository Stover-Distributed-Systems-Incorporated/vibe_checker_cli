import {chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

export interface Credentials {
  access_token: string
  /** Epoch milliseconds at which the access token expires. */
  expires_at: number
  refresh_token: string
}

function isValidCredentials(obj: unknown): obj is Credentials {
  if (!obj || typeof obj !== 'object') return false
  const c = obj as Record<string, unknown>
  return (
    typeof c.access_token === 'string' &&
    typeof c.expires_at === 'number' &&
    typeof c.refresh_token === 'string'
  )
}

// --- OS keychain via keytar (macOS Keychain, libsecret on Linux, Windows Credential Manager) ---

const KEYCHAIN_SERVICE = 'vibechecker'
const KEYCHAIN_ACCOUNT = 'session'

type KeytarModule = {
  deletePassword(service: string, account: string): Promise<boolean>
  getPassword(service: string, account: string): Promise<null | string>
  setPassword(service: string, account: string, password: string): Promise<void>
}

let _keytar: KeytarModule | null | undefined // undefined = not yet resolved

async function getKeytar(): Promise<KeytarModule | null> {
  if (_keytar !== undefined) return _keytar
  try {
    // keytar is a CJS native module; with Node16 module resolution its exports land on .default.
    const mod = await import('keytar')
    _keytar = (mod as unknown as {default: KeytarModule}).default ?? null
  } catch {
    // Module missing or native binding failed to load (no prebuild for this platform).
    _keytar = null
  }

  return _keytar
}

/**
 * Permanently disable the keychain for this process. The module can load yet still
 * fail every call at runtime — e.g. a headless Linux box with no Secret Service, or a
 * locked keychain. When that happens we fall back to the file and stop retrying keytar.
 */
function disableKeytar(): void {
  _keytar = null
}

// --- File fallback (kept for CI / headless environments) ---

const CREDENTIALS_FILE = 'credentials.json'

function credentialsPath(configDir: string): string {
  return join(configDir, CREDENTIALS_FILE)
}

async function loadFromFile(configDir: string): Promise<Credentials | null> {
  try {
    const raw = await readFile(credentialsPath(configDir), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isValidCredentials(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function saveToFile(configDir: string, creds: Credentials): Promise<void> {
  await mkdir(configDir, {mode: 0o700, recursive: true})
  const file = credentialsPath(configDir)
  await writeFile(file, JSON.stringify(creds, null, 2), {mode: 0o600})
  // Re-assert perms in case the file already existed with looser permissions.
  await chmod(file, 0o600)
}

// --- Public API ---

/**
 * Persist session tokens. Prefers the OS keychain; falls back to a 0600 JSON
 * file in the oclif config directory for CI/headless environments.
 */
export async function saveCredentials(configDir: string, creds: Credentials): Promise<void> {
  const kt = await getKeytar()
  if (kt) {
    try {
      await kt.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify(creds))
      return
    } catch {
      // Keychain present but unusable — fall through to the file fallback.
      disableKeytar()
    }
  }

  await saveToFile(configDir, creds)
}

/**
 * Load the stored session, or null if the user is not logged in.
 * If keytar is available and the file still holds credentials from an older
 * CLI version, automatically migrates them into the keychain and removes the file.
 */
export async function loadCredentials(configDir: string): Promise<Credentials | null> {
  const kt = await getKeytar()
  if (kt) {
    let raw: null | string
    try {
      raw = await kt.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    } catch {
      // Keychain present but unusable — fall back to the file without touching it.
      disableKeytar()
      return loadFromFile(configDir)
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (isValidCredentials(parsed)) return parsed
      } catch { /* corrupted entry — fall through to file migration */ }
    }

    // Migrate any pre-keychain file into the keychain on first run after upgrade.
    const fileCreds = await loadFromFile(configDir)
    if (fileCreds) {
      try {
        await kt.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify(fileCreds))
        await rm(credentialsPath(configDir), {force: true})
      } catch {
        // Migration write failed — leave the file in place and keep using it.
        disableKeytar()
      }
    }

    return fileCreds
  }

  return loadFromFile(configDir)
}

/** Remove the stored session (used by logout). Clears both keychain and any leftover file. */
export async function clearCredentials(configDir: string): Promise<void> {
  const kt = await getKeytar()
  if (kt) {
    try {
      await kt.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    } catch {
      // Keychain unusable — nothing to clear there; still remove the file below.
    }
  }

  // Always remove the file too — it may be a migration artifact or the fallback store.
  await rm(credentialsPath(configDir), {force: true})
}

// --- Provider API key storage (unchanged, file-only) ---

const PROVIDER_KEYS_FILE = 'provider-keys.json'

function providerKeysPath(configDir: string): string {
  return join(configDir, PROVIDER_KEYS_FILE)
}

/** Persist an API key for a provider in the oclif config dir at 0600. */
export async function saveProviderKey(configDir: string, providerID: string, apiKey: string): Promise<void> {
  await mkdir(configDir, {mode: 0o700, recursive: true})
  const file = providerKeysPath(configDir)
  let existing: Record<string, string> = {}
  try {
    existing = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>
  } catch {
    // first write
  }

  existing[providerID] = apiKey
  await writeFile(file, JSON.stringify(existing, null, 2), {mode: 0o600})
  await chmod(file, 0o600)
}

/** Load a stored API key for a provider, or null if not set. */
export async function loadProviderKey(configDir: string, providerID: string): Promise<null | string> {
  try {
    const keys = JSON.parse(await readFile(providerKeysPath(configDir), 'utf8')) as Record<string, string>
    return keys[providerID] ?? null
  } catch {
    return null
  }
}
