/* eslint-disable camelcase -- request/response fields mirror the API's snake_case JSON contract */
/* eslint-disable n/no-unsupported-features/node-builtins -- fetch/Response are available in our Node 18+ runtime */
import {mkdir, open, rm, stat} from 'node:fs/promises'
import {join} from 'node:path'

import type {MapModule} from './opencode.js'

import {loadCredentials, saveCredentials} from './credentials.js'

export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token: string
  token_type: string
}

export interface Project {
  _id: string
  description?: string
  name: string
}

/** The repo's git state at map time. All fields optional/nullable so a non-git map still works. */
export interface GitInfo {
  branch: null | string
  dirty: boolean
  sha: null | string
}

export interface ImportMapSummary {
  created_functions: number
  created_modules: number
  modules: Array<{functions: Array<{function_doc_id: string; name: string}>; module_id: string; name: string}>
  /** Files served from the content-hash cache instead of re-mapping (when a hash was sent). */
  reused_count?: number
  /** Id of the snapshot frozen for this map run, present only when a git sha was sent. */
  snapshot_id?: string
  updated_functions: number
  updated_modules: number
}

export interface MapFilesSummary extends ImportMapSummary {
  failed: Array<{error: string; file_name: string}>
  failed_count: number
  mapped_count: number
}

interface RequestOptions {
  body?: unknown
  method?: string
  token?: string
}

/**
 * Send a JSON request to the API as a CLI client. The X-Client-Type header tells the
 * API to treat us as a non-browser client. A bearer token, when supplied, authenticates
 * the request. Throws an Error carrying the API's `detail` message on a non-2xx response.
 */
async function request<T>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  const {body, method = 'GET', token} = options
  const headers: Record<string, string> = {'X-Client-Type': 'cli'}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not reach the API at ${baseUrl}: ${reason}`)
  }

  const data = (await response.json().catch(() => null)) as null | Record<string, unknown>

  if (!response.ok) {
    const detail = (data?.detail as string) ?? `Request failed with status ${response.status}`
    throw new Error(detail)
  }

  return data as T
}

/** Authenticate with a username/email + password and receive a token pair. */
export async function signin(baseUrl: string, identifier: string, password: string): Promise<TokenResponse> {
  return request<TokenResponse>(baseUrl, '/authenticate-signin', {
    body: {password, user_identifier: identifier},
    method: 'POST',
  })
}

/** Exchange a refresh token for a fresh token pair (the old one is rotated out). */
async function refresh(baseUrl: string, refreshToken: string): Promise<TokenResponse> {
  return request<TokenResponse>(baseUrl, '/refresh', {body: {refresh_token: refreshToken}, method: 'POST'})
}

/**
 * Revoke session(s) server-side. The refresh token identifies the session. `scope`
 * controls how much is revoked: 'all' deletes every refresh token for the user
 * (logs out all devices), 'current' deletes only this session.
 */
export async function logoutSession(
  baseUrl: string,
  refreshToken: string,
  scope: 'all' | 'current' = 'all',
): Promise<void> {
  await request<{message: string}>(baseUrl, '/logout', {
    body: {refresh_token: refreshToken, scope},
    method: 'POST',
  })
}

// --- Concurrent-safe token refresh ---

const REFRESH_SKEW_MS = 30_000
const LOCK_FILE = '.refresh.lock'
const LOCK_TTL_MS = 5000   // a lock older than this is considered stale
const LOCK_WAIT_MS = 3000  // how long we'll wait before giving up on the lock
const LOCK_POLL_MS = 100

/**
 * Run `fn` while holding a per-configDir file lock, preventing two concurrent
 * CLI processes from both trying to rotate the same refresh token.
 */
async function withRefreshLock<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
  // When credentials live in the OS keychain the config dir may never have been
  // created, so ensure it exists before we try to open a lock file inside it —
  // otherwise the atomic open below fails with ENOENT instead of EEXIST.
  await mkdir(configDir, {mode: 0o700, recursive: true})

  const lockPath = join(configDir, LOCK_FILE)
  const deadline = Date.now() + LOCK_WAIT_MS

  // This is a sequential lock-polling retry loop: each attempt must complete
  // before the next, so awaiting inside the loop is intentional here.
  /* eslint-disable no-await-in-loop */
  for (;;) {
    try {
      // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic, fails if the file already exists.
      const fd = await open(lockPath, 'wx', 0o600)
      try {
        return await fn()
      } finally {
        await fd.close()
        await rm(lockPath, {force: true})
      }
    } catch (error: unknown) {
      const code = error instanceof Object && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
      if (code !== 'EEXIST') throw error

      // Lock file exists — clear it if stale so we don't deadlock after a crash.
      try {
        const s = await stat(lockPath)
        if (Date.now() - s.mtimeMs > LOCK_TTL_MS) {
          await rm(lockPath, {force: true})
          continue
        }
      } catch { /* lock was removed between our check and stat; retry */ }

      if (Date.now() > deadline) {
        throw new Error('Token refresh lock timed out — another process may be hung.')
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, LOCK_POLL_MS)
      })
    }
  }
  /* eslint-enable no-await-in-loop */
}

/**
 * Return a valid access token for authenticated calls, transparently rotating it via the
 * stored refresh token when it has expired (or is about to). The refresh is protected by a
 * file lock so two concurrent CLI invocations don't both try to rotate the same token.
 * Throws with a login hint if the user is not logged in or the session can no longer be refreshed.
 */
export async function ensureAccessToken(baseUrl: string, configDir: string): Promise<string> {
  const creds = await loadCredentials(configDir)
  if (!creds) throw new Error('Not logged in. Run `vibechecker login` first.')

  if (Date.now() < creds.expires_at - REFRESH_SKEW_MS) return creds.access_token

  return withRefreshLock(configDir, async () => {
    // Re-read after acquiring the lock — another process may have already refreshed.
    const fresh = await loadCredentials(configDir)
    if (fresh && Date.now() < fresh.expires_at - REFRESH_SKEW_MS) return fresh.access_token

    const tokenSource = fresh ?? creds
    try {
      const tokens = await refresh(baseUrl, tokenSource.refresh_token)
      await saveCredentials(configDir, {
        access_token: tokens.access_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        refresh_token: tokens.refresh_token,
      })
      return tokens.access_token
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Session refresh failed (${reason}). Run \`vibechecker login\` again.`)
    }
  })
}

/** List the authenticated user's projects. */
export async function listProjects(baseUrl: string, configDir: string): Promise<Project[]> {
  const token = await ensureAccessToken(baseUrl, configDir)
  return request<Project[]>(baseUrl, '/projects', {token})
}

/** Create a new project and return its id. */
export async function createProject(
  baseUrl: string,
  configDir: string,
  name: string,
  description: string,
): Promise<{project_id: string}> {
  const token = await ensureAccessToken(baseUrl, configDir)
  return request<{project_id: string}>(baseUrl, '/create-project', {
    body: {project_description: description, project_name: name},
    method: 'POST',
    token,
  })
}

/** Merge a crawled module/function map into an existing project. */
export async function importMap(
  baseUrl: string,
  configDir: string,
  projectId: string,
  modules: MapModule[],
): Promise<ImportMapSummary> {
  const token = await ensureAccessToken(baseUrl, configDir)
  return request<ImportMapSummary>(baseUrl, '/project/map', {
    body: {modules, project_id: projectId},
    method: 'POST',
    token,
  })
}

export async function mapFile(
  baseUrl: string,
  configDir: string,
  params: {contentHash?: string; fileContent: string; fileName: string; git?: GitInfo; projectId: string},
): Promise<ImportMapSummary> {
  const token = await ensureAccessToken(baseUrl, configDir)
  return request<ImportMapSummary>(baseUrl, '/project/map-file', {
    body: {
      content_hash: params.contentHash,
      file_content: params.fileContent,
      file_name: params.fileName,
      git: params.git,
      project_id: params.projectId,
    },
    method: 'POST',
    token,
  })
}

/** Map many files in one batch request. The server maps them concurrently and reports per-file failures. */
export async function mapFiles(
  baseUrl: string,
  configDir: string,
  params: {files: Array<{content: string; contentHash?: string; fileName: string}>; git?: GitInfo; projectId: string},
): Promise<MapFilesSummary> {
  const token = await ensureAccessToken(baseUrl, configDir)
  return request<MapFilesSummary>(baseUrl, '/project/map-files', {
    body: {
      files: params.files.map((f) => ({content_hash: f.contentHash, file_content: f.content, file_name: f.fileName})),
      git: params.git,
      project_id: params.projectId,
    },
    method: 'POST',
    token,
  })
}
