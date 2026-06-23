import {createOpencode} from '@opencode-ai/sdk'
import {open, stat, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'

import type {SourceFileCandidate} from './files.js'

export interface MapFunction {
  calls?: string[]
  description?: string
  errors?: Array<Record<string, unknown>>
  inputs?: Array<Record<string, unknown>>
  name: string
  outputs?: Array<Record<string, unknown>>
  steps?: string[]
}

export interface MapModule {
  description?: string
  functions: MapFunction[]
  name: string
}

export interface ProjectMap {
  modules: MapModule[]
  project?: {description?: string; name?: string}
}

export interface ProviderInfo {
  id: string
  models: Array<{id: string; name: string}>
  name: string
}

export type Logger = (message: string) => void

export interface CrawlOptions {
  log?: Logger
  verbose?: boolean
}

export interface EngineModel {
  apiKey: string
  // Custom OpenAI-compatible base URL (our Pro inference proxy). When set, OpenCode
  // routes the model through this endpoint instead of a built-in provider.
  baseURL?: string
  modelID: string
  providerID: string
}

// Derive the server config + provider-entry types straight from the SDK so our object
// matches what createOpencode expects (no import-name guessing, no casts).
type ServerConfig = NonNullable<NonNullable<Parameters<typeof createOpencode>[0]>['config']>
type ServerProviderConfig = NonNullable<ServerConfig['provider']>[string]

export interface FileSelection {
  files: string[]
}

type ToolPartLike = {callID: string; state: {error?: string; input?: unknown; status: string}; tool: string}

// OpenCode writes its server log here; we tail it to explain a server-side crash.
const OPENCODE_LOG_FILE = join(homedir(), '.local', 'share', 'opencode', 'log', 'opencode.log')

const CRAWL_PROMPT = `You are a code cartographer. Map this codebase into a structured module/function tree.

Rules:
- Explore the project's source files in the working directory. IGNORE dependency and build bloat: node_modules, vendor, dist, build, out, .next, target, .git, coverage, and lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock). Never document third-party library code.
- Group the project's OWN source into logical MODULES (by feature/area/directory).
- For each module, list its key FUNCTIONS. For each function provide:
  - name (string)
  - description (one sentence)
  - inputs: array of {name, type, description}
  - outputs: array of {type, description}
  - steps: array of short high-level strings
  - calls: array of other function names it invokes
  - errors: array of {type, description}
- Omit a field rather than inventing details you cannot determine from the code.

Output ONLY a single JSON object — no prose, no markdown fences — in exactly this shape:
{"project":{"name":"","description":""},"modules":[{"name":"","description":"","functions":[{"name":"","description":"","inputs":[],"outputs":[],"steps":[],"calls":[],"errors":[]}]}]}`

const MAX_SELECTION_MANIFEST_BYTES = 64 * 1024

/** Prefer likely application code if a very large repository needs a bounded manifest. */
function candidatePriority(candidate: SourceFileCandidate): number {
  const path = candidate.fileName.toLowerCase()
  let score = 0
  if (/(^|\/)(src|app|apps|api|server|client|lib|core|domain|feature|features|internal|cmd)(\/|$)/.test(path)) score += 100
  if (/(^|\/)(index|main|server|app|cli|command)\.[cm]?[jt]sx?$/.test(path)) score += 50
  if (/(^|\/)(test|tests|__tests__|spec|specs|fixtures|examples|demo)(\/|$)/.test(path)) score -= 30
  return score
}

/**
 * Give the model a compact, locally-filtered project manifest rather than an
 * open-ended filesystem. That keeps selection to one model turn and makes the
 * paths it can choose both predictable and safe.
 */
function buildFileSelectionPrompt(candidates: SourceFileCandidate[]): string {
  const ranked = [...candidates].sort((a, b) => (
    candidatePriority(b) - candidatePriority(a) || a.fileName.localeCompare(b.fileName)
  ))
  const paths: string[] = []
  let bytes = 0
  for (const candidate of ranked) {
    const line = `${candidate.fileName} (${candidate.size} bytes)`
    if (paths.length > 0 && bytes + line.length + 1 > MAX_SELECTION_MANIFEST_BYTES) break
    paths.push(line)
    bytes += line.length + 1
  }

  const omitted = candidates.length - paths.length
  const truncation = omitted > 0
    ? `\nThe manifest was capped for speed; ${omitted} lower-priority candidate paths were omitted.\n`
    : ''

  return `You are selecting the smallest useful set of files for understanding a software project.

You have NO filesystem tools. Do not attempt to explore, search, or read the working directory. The candidate manifest below was generated locally: it contains only project source files and already excludes dependency directories, build output, hidden files, lockfiles, unsupported files, and files ignored by Git when this is a Git repository.

Choose high-signal application entry points, feature code, domain logic, API handlers, and tests only when they materially explain behavior. Favor a useful representative set over exhaustive coverage. Select only exact paths from the manifest.${truncation}
Candidate source manifest (${paths.length}/${candidates.length} paths):
${paths.join('\n')}

Output ONLY a single JSON object with this exact shape:
{"files":["relative/path/to/source.ts"]}`
}

// Explicitly disable every filesystem and mutating tool used by the built-in
// coding agent. The model's only input for this fast selection run is the
// manifest above, so it has no reason to start an exploratory tool loop.
const MANIFEST_ONLY_TOOLS = {
  bash: false,
  edit: false,
  glob: false,
  grep: false,
  list: false,
  patch: false,
  read: false,
  write: false,
}

type MessageError = {data?: Record<string, unknown>; name?: string}

function buildServerConfig(
  opts: {apiKey: string; baseURL?: string; modelID?: string; providerID: string},
  verbose: boolean,
): ServerConfig {
  const {apiKey, baseURL, modelID, providerID} = opts
  // A baseURL means a custom OpenAI-compatible endpoint (our Pro inference proxy):
  // register it as a provider so OpenCode routes the configured model through it.
  const providerEntry: ServerProviderConfig = {options: baseURL ? {apiKey, baseURL} : {apiKey}}
  if (baseURL) {
    providerEntry.npm = '@ai-sdk/openai-compatible'
    providerEntry.name = 'Vibe Checker'
    if (modelID) providerEntry.models = {[modelID]: {name: modelID}}
  }

  const config: ServerConfig = {provider: {[providerID]: providerEntry}}
  if (verbose) config.logLevel = 'DEBUG'
  return config
}

/**
 * Start an OpenCode instance owned by this CLI invocation. Port 0 asks the OS
 * for a free loopback port, which keeps it isolated from a user's TUI, editor,
 * or another VibeChecker run. The close hook is idempotent and is also wired to
 * process exit, termination signals, and uncaught exceptions so this child
 * process cannot linger after the CLI does.
 */
async function startManagedOpenCode(config: ReturnType<typeof buildServerConfig>) {
  const {client, server} = await createOpencode({config, port: 0})
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    process.off('exit', close)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('uncaughtExceptionMonitor', close)
    server.close()
  }

  // Restore Node's standard signal behavior after stopping our child process.
  // Re-sending the signal after removing the listener exits with the expected
  // signal status instead of leaving the CLI running after Ctrl+C.
  const forwardSignal = (signal: NodeJS.Signals) => {
    close()
    process.kill(process.pid, signal)
  }

  const onSigint = () => forwardSignal('SIGINT')
  const onSigterm = () => forwardSignal('SIGTERM')

  process.once('exit', close)
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  // This monitor observes a crash without overriding Node's default crash exit.
  process.once('uncaughtExceptionMonitor', close)

  return {client, close, url: server.url}
}

/** Turn OpenCode's structured message error into an actionable, human-readable line. */
function describeMessageError(error: MessageError): string {
  const data = (error.data ?? {}) as Record<string, unknown>
  switch (error.name) {
    case 'APIError': {
      const status = data.statusCode ? ` (HTTP ${data.statusCode})` : ''
      const body = typeof data.responseBody === 'string' ? ` — ${data.responseBody.slice(0, 500)}` : ''
      return `Provider API error${status}: ${data.message ?? 'unknown'}${body}`
    }

    case 'MessageAbortedError': {
      return `The request was aborted: ${data.message ?? 'unknown'}`
    }

    case 'MessageOutputLengthError': {
      return 'The model hit its maximum output length before finishing the map (response truncated). Try a model with a larger output limit, or map a smaller scope.'
    }

    case 'ProviderAuthError': {
      return `Authentication failed for provider "${data.providerID}": ${data.message ?? 'check your API key'}`
    }

    default: {
      return (data.message as string) ?? error.name ?? 'Unknown error'
    }
  }
}

/** Flatten an Error and its nested `cause` chain (node fetch wraps the real cause). */
function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const segments = [error.message]
  let {cause} = error as {cause?: unknown}
  while (cause instanceof Error) {
    const c = cause as Error & {code?: string; errno?: number; syscall?: string}
    const code = c.code ?? c.name
    const syscall = c.syscall ? ` (syscall ${c.syscall})` : ''
    segments.push(`${code}: ${c.message}${syscall}`)
    cause = (cause as {cause?: unknown}).cause
  }

  return segments.join(' → ')
}

async function logSize(): Promise<number> {
  try {
    return (await stat(OPENCODE_LOG_FILE)).size
  } catch {
    return 0
  }
}

/** Read the bytes appended to the OpenCode log since `since` (capped), for crash diagnostics. */
async function readLogTail(since: number, maxBytes = 12_000): Promise<string> {
  try {
    const handle = await open(OPENCODE_LOG_FILE, 'r')
    try {
      const {size} = await handle.stat()
      const start = Math.max(since, size - maxBytes)
      const length = size - start
      if (length <= 0) return ''
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      return buffer.toString('utf8').trim()
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

function toolHint(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of ['filePath', 'path', 'pattern', 'query', 'command']) {
    if (typeof obj[key] === 'string') return ` ${obj[key] as string}`
  }

  return ''
}

/** Log a tool part once per status change so the user sees what the crawler is doing. */
function narrateToolPart(part: ToolPartLike, seen: Map<string, string>, log: Logger): void {
  if (part.state.status === seen.get(part.callID)) return
  seen.set(part.callID, part.state.status)
  const hint = part.state.status === 'running' ? toolHint(part.state.input) : ''
  log(`  → ${part.tool} [${part.state.status}]${hint}`)
  if (part.state.status === 'error') log(`    ${part.state.error ?? ''}`)
}

function parseMap(text: string): ProjectMap {
  let raw = text.trim()

  // Strip a ```json ... ``` fence if the model wrapped its output despite instructions.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()

  // Otherwise, slice from the first { to the last } to drop any stray prose.
  if (!raw.startsWith('{')) {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start !== -1 && end > start) raw = raw.slice(start, end + 1)
  }

  const parsed = JSON.parse(raw) as ProjectMap
  if (!parsed || !Array.isArray(parsed.modules)) {
    throw new Error('OpenCode output did not contain a "modules" array.')
  }

  // Keep only well-formed entries.
  parsed.modules = parsed.modules
    .filter((m) => m && typeof m.name === 'string')
    .map((m) => ({
      ...m,
      functions: Array.isArray(m.functions) ? m.functions.filter((f) => f && typeof f.name === 'string') : [],
    }))

  return parsed
}

function parseFileSelection(text: string): FileSelection {
  let raw = text.trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  if (!raw.startsWith('{')) {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start !== -1 && end > start) raw = raw.slice(start, end + 1)
  }

  const parsed = JSON.parse(raw) as {files?: unknown}
  if (!Array.isArray(parsed?.files)) {
    throw new TypeError('OpenCode output did not contain a "files" array.')
  }

  // A second local filter happens before any file is read. This only makes the
  // model response predictable and rejects obvious paths outside the project.
  const files = [...new Set(parsed.files.filter((file): file is string => (
    typeof file === 'string' &&
    file.length > 0 &&
    !file.startsWith('/') &&
    !file.split(/[\\/]/).includes('..')
  )))]
  return {files}
}

/**
 * Spin up an OpenCode server with the given provider API key, fetch the full provider
 * list, and return a simplified list of providers (name, id, models[]).
 */
export async function listProviders(providerID: string, apiKey: string): Promise<ProviderInfo[]> {
  const {client, close} = await startManagedOpenCode(buildServerConfig({apiKey, providerID}, false))
  try {
    const result = await client.provider.list()
    const all = result.data?.all ?? []
    return all.map((p) => ({
      id: p.id,
      models: Object.entries(p.models ?? {})
        .filter(([, m]) => m.status !== 'deprecated')
        .map(([id, m]) => ({id, name: m.name}))
        .sort((a, b) => a.name.localeCompare(b.name)),
      name: p.name,
    }))
  } finally {
    close()
  }
}

/**
 * Ask OpenCode to identify the project's meaningful source files. The returned
 * paths are relative to rootDir and must still be validated by the caller before
 * reading or uploading them.
 */
export async function selectProjectFiles(
  rootDir: string,
  model: EngineModel,
  candidates: SourceFileCandidate[],
  options: CrawlOptions = {},
): Promise<FileSelection> {
  const {modelID, providerID} = model
  const verbose = options.verbose ?? false
  const log: Logger = options.log ?? (() => {})
  const {client, close} = await startManagedOpenCode(buildServerConfig(model, verbose))

  try {
    const created = await client.session.create({body: {title: 'vibechecker select files'}, query: {directory: rootDir}})
    const session = created.data
    if (!session) throw new Error('Failed to start an OpenCode session.')
    if (verbose) log(`Session ${session.id} created; selecting project files…`)

    const result = await client.session.prompt({
      body: {
        model: {modelID, providerID},
        parts: [{text: buildFileSelectionPrompt(candidates), type: 'text'}],
        // A single-turn selection must not turn into agent-driven code exploration.
        tools: MANIFEST_ONLY_TOOLS,
      },
      path: {id: session.id},
      query: {directory: rootDir},
    })
    const info = result.data?.info as undefined | {error?: MessageError}
    if (info?.error) throw new Error(`OpenCode could not select files: ${describeMessageError(info.error)}`)

    const text = (result.data?.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => (part as {text: string}).text)
      .join('\n')
      .trim()
    if (!text) throw new Error('OpenCode returned no file selection. Verify the provider, API key, and model.')

    return parseFileSelection(text)
  } catch (error) {
    throw new Error(`OpenCode file selection failed: ${formatError(error)}`)
  } finally {
    close()
  }
}

/**
 * Drive the OpenCode engine as a read-only crawler over rootDir and return the parsed
 * module/function map. With `verbose`, streams live OpenCode events (tool calls, errors)
 * and, on a crash, includes the cause chain plus a tail of the OpenCode server log.
 */
export async function crawlProject(rootDir: string, model: EngineModel, options: CrawlOptions = {}): Promise<ProjectMap> {
  const {modelID, providerID} = model
  const verbose = options.verbose ?? false
  const log: Logger = options.log ?? (() => {})

  const logOffset = verbose ? await logSize() : 0
  const {client, close, url} = await startManagedOpenCode(buildServerConfig(model, verbose))
  if (verbose) log(`OpenCode server listening on ${url}`)

  // Subscribe to the event stream so we can narrate progress and capture the real failure.
  let capturedError: MessageError | undefined
  const toolStatus = new Map<string, string>()
  const consumeEvents = async () => {
    try {
      const subscription = await client.event.subscribe()
      for await (const event of subscription.stream) {
        if (event.type === 'session.error') {
          if (event.properties.error) {
            capturedError = event.properties.error as MessageError
            log(`! session.error: ${describeMessageError(capturedError)}`)
          }
        } else if (event.type === 'server.instance.disposed') {
          log('! server.instance.disposed (the OpenCode server is shutting down)')
        } else if (event.type === 'message.part.updated' && event.properties.part.type === 'tool') {
          narrateToolPart(event.properties.part, toolStatus, log)
        }
      }
    } catch (error) {
      if (verbose) log(`(event stream ended: ${formatError(error)})`)
    }
  }

  const eventLoop = verbose ? consumeEvents() : Promise.resolve()

  try {
    const created = await client.session.create({body: {title: 'vibechecker map'}, query: {directory: rootDir}})
    const session = created.data
    if (!session) throw new Error('Failed to start an OpenCode session.')
    if (verbose) log(`Session ${session.id} created; sending crawl prompt…`)

    let result
    try {
      result = await client.session.prompt({
        body: {
          model: {modelID, providerID},
          parts: [{text: CRAWL_PROMPT, type: 'text'}],
          // Read-only crawl: disable mutating tools so the headless run never blocks on a permission prompt.
          tools: {bash: false, edit: false, patch: false, write: false},
        },
        path: {id: session.id},
        query: {directory: rootDir},
      })
    } catch (error) {
      // The client→local-server request failed — almost always the server process crashed.
      const detail = formatError(error)
      const captured = capturedError ? `\nLast session error: ${describeMessageError(capturedError)}` : ''
      const tail = await readLogTail(logOffset)
      const logHint = tail
        ? `\n\n--- opencode.log (tail) ---\n${tail}`
        : `\nSee the OpenCode log at ${OPENCODE_LOG_FILE} (re-run with -v for live events).`
      throw new Error(`OpenCode request failed: ${detail}. The local OpenCode server likely crashed.${captured}${logHint}`)
    }

    // The request can succeed at the HTTP level but still carry a model/provider error.
    const info = result.data?.info as undefined | {error?: MessageError}
    if (info?.error) {
      throw new Error(`OpenCode could not complete the map: ${describeMessageError(info.error)}`)
    }

    const parts = result.data?.parts ?? []
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as {text: string}).text)
      .join('\n')
      .trim()

    if (!text) {
      const captured = capturedError ? ` (${describeMessageError(capturedError)})` : ''
      throw new Error(`OpenCode returned no output.${captured} Verify your API key and that the model supports tool calls.`)
    }

    try {
      return parseMap(text)
    } catch (error) {
      const debugPath = join(rootDir, '.vibe-checker.debug.json')
      await writeFile(debugPath, text, 'utf8')
      throw new Error(`${formatError(error)} Raw OpenCode output saved to ${debugPath}.`)
    }
  } finally {
    close()
    await eventLoop.catch(() => {})
  }
}
