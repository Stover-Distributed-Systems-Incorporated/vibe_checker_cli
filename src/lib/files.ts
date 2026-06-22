import {execFile} from 'node:child_process'
import {readdir, readFile, stat} from 'node:fs/promises'
import {extname, join, relative, sep} from 'node:path'

export interface SourceFile {
  content: string
  /** Path relative to the walked root (POSIX separators), used as the module's file_name. */
  fileName: string
}

/** A locally-discovered source file whose contents have not been read yet. */
export interface SourceFileCandidate {
  /** Path relative to the scanned root (POSIX separators), used as the module's file_name. */
  fileName: string
  /** Absolute path used only while the CLI is preparing this mapping run. */
  path: string
  size: number
}

export interface CollectResult {
  files: SourceFile[]
  skipped: Array<{path: string; reason: string}>
}

export interface CandidateResult {
  files: SourceFileCandidate[]
  /** True when Git supplied the file set with its standard ignore rules applied. */
  gitignoreApplied: boolean
  skipped: Array<{path: string; reason: string}>
}

export interface CollectOptions {
  /** Files larger than this are skipped as likely generated/minified. Default 256 KiB. */
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 256 * 1024

// Directory names that only ever hold dependency, build, or VCS bloat — never the
// project's own source. Mirrors the ignore list in opencode.ts's crawl prompt.
const IGNORE_DIRS = new Set([
  '.git',
  '.next',
  '.svn',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
])

// Files we never map even when their extension is allowed.
const IGNORE_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'yarn.lock',
])

// Tooling configuration is executable in some ecosystems but does not describe
// the application's behavior, so it is not useful input for a project map.
const CONFIG_ONLY_FILE_PREFIXES = new Set([
  'astro',
  'babel',
  'cypress',
  'drizzle',
  'eslint',
  'jest',
  'knex',
  'next',
  'nuxt',
  'playwright',
  'postcss',
  'prettier',
  'prisma',
  'rollup',
  'stylelint',
  'svelte',
  'tailwind',
  'tsup',
  'vite',
  'vitest',
  'webpack',
])

// Extension allowlist — only recognized source files are mapped, so a stray
// image, PDF, or data dump in the tree can't bloat or break the batch.
const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.m',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scala',
  '.sh',
  '.svelte',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
])

/** Heuristic binary sniff: a NUL byte in the first 8 KiB means it isn't text source. */
function looksBinary(buffer: Buffer): boolean {
  const span = Math.min(buffer.length, 8192)
  for (let i = 0; i < span; i++) {
    if (buffer[i] === 0) return true
  }

  return false
}

function asRelativePath(rootDir: string, fullPath: string): string {
  return relative(rootDir, fullPath).split(sep).join('/')
}

function hasIgnoredDirectory(fileName: string): boolean {
  return fileName.split('/').some((part) => part.startsWith('.') || IGNORE_DIRS.has(part))
}

function skipReason(fileName: string): string | undefined {
  const baseName = fileName.slice(fileName.lastIndexOf('/') + 1)
  if (hasIgnoredDirectory(fileName) || baseName.startsWith('.') || IGNORE_FILES.has(baseName)) return 'ignored file'
  const configPrefix = baseName.match(/^([a-z0-9-]+)\.config\.[cm]?[jt]sx?$/i)?.[1]?.toLowerCase()
  if (configPrefix && CONFIG_ONLY_FILE_PREFIXES.has(configPrefix)) return 'configuration-only file'
  if (!SOURCE_EXTENSIONS.has(extname(baseName).toLowerCase())) return 'unsupported extension'
  return undefined
}

/**
 * Ask Git for tracked and unignored files. This applies .gitignore, .git/info/exclude,
 * and the user's Git excludes without ever walking dependency directories ourselves.
 */
async function gitProjectFiles(rootDir: string): Promise<null | string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', rootDir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {encoding: 'buffer', maxBuffer: 8 * 1024 * 1024},
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }

        resolve(
          stdout.toString('utf8')
            .split('\0')
            .filter(Boolean),
        )
      },
    )
  })
}

async function candidateFromPath(
  rootDir: string,
  fileName: string,
  maxBytes: number,
): Promise<{candidate?: SourceFileCandidate; skipped?: {path: string; reason: string}}> {
  const normalized = fileName.split('\\').join('/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return {skipped: {path: fileName, reason: 'outside project root'}}
  }

  const initialSkip = skipReason(normalized)
  if (initialSkip) return {skipped: {path: normalized, reason: initialSkip}}

  const fullPath = join(rootDir, normalized)
  try {
    const info = await stat(fullPath)
    if (!info.isFile()) return {skipped: {path: normalized, reason: 'not a regular file'}}
    if (info.size > maxBytes) return {skipped: {path: normalized, reason: `too large (${info.size} bytes > ${maxBytes})`}}
    return {candidate: {fileName: normalized, path: fullPath, size: info.size}}
  } catch {
    return {skipped: {path: normalized, reason: 'unreadable or missing'}}
  }
}

/**
 * Find eligible project code without opening source files. Git repositories use
 * Git's own ignore engine; a non-Git directory falls back to the local ignore
 * rules below. The result can be sent as a lightweight manifest to a selector.
 */
export async function collectSourceFileCandidates(rootDir: string, options: CollectOptions = {}): Promise<CandidateResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const files: SourceFileCandidate[] = []
  const skipped: Array<{path: string; reason: string}> = []
  const gitFiles = await gitProjectFiles(rootDir)

  if (gitFiles) {
    for (const fileName of gitFiles) {
      // eslint-disable-next-line no-await-in-loop -- bounded sequential stat avoids EMFILE on large repositories.
      const result = await candidateFromPath(rootDir, fileName, maxBytes)
      if (result.candidate) files.push(result.candidate)
      if (result.skipped) skipped.push(result.skipped)
    }

    files.sort((a, b) => a.fileName.localeCompare(b.fileName))
    return {files, gitignoreApplied: true, skipped}
  }

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, {withFileTypes: true})
    // The walk is intentionally sequential: a parallel Promise.all recursion would
    // open every source file across the tree at once and risk EMFILE on large repos.
    /* eslint-disable no-await-in-loop -- bounded sequential FS walk by design */
    for (const entry of entries) {
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(full)
        continue
      }

      if (!entry.isFile()) continue
      const result = await candidateFromPath(rootDir, asRelativePath(rootDir, full), maxBytes)
      if (result.candidate) files.push(result.candidate)
      if (result.skipped) skipped.push(result.skipped)
    }
    /* eslint-enable no-await-in-loop */
  }

  await walk(rootDir)
  files.sort((a, b) => a.fileName.localeCompare(b.fileName))
  return {files, gitignoreApplied: false, skipped}
}

/** Read only the source files that survived a prior selection step. */
export async function readSourceFileCandidates(
  candidates: SourceFileCandidate[],
  options: CollectOptions = {},
): Promise<CollectResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const files: SourceFile[] = []
  const skipped: Array<{path: string; reason: string}> = []

  /* eslint-disable no-await-in-loop -- selected files are read sequentially to avoid EMFILE. */
  for (const candidate of candidates) {
    try {
      // Recheck size because a file could have changed after the manifest was made.
      const {size} = await stat(candidate.path)
      if (size > maxBytes) {
        skipped.push({path: candidate.fileName, reason: `too large (${size} bytes > ${maxBytes})`})
        continue
      }

      const buffer = await readFile(candidate.path)
      if (looksBinary(buffer)) {
        skipped.push({path: candidate.fileName, reason: 'binary'})
        continue
      }

      files.push({content: buffer.toString('utf8'), fileName: candidate.fileName})
    } catch {
      skipped.push({path: candidate.fileName, reason: 'unreadable or missing'})
    }
  }
  /* eslint-enable no-await-in-loop */

  files.sort((a, b) => a.fileName.localeCompare(b.fileName))
  return {files, skipped}
}

/**
 * Recursively collect mappable source files under `rootDir`, applying strict
 * filtering (ignored dirs, dotfiles, lockfiles, extension allowlist, size cap,
 * binary sniff) so only real source is ever uploaded to the batch endpoint.
 * Returns the surviving files plus a list of what was skipped and why.
 */
export async function collectSourceFiles(rootDir: string, options: CollectOptions = {}): Promise<CollectResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const files: SourceFile[] = []
  const skipped: Array<{path: string; reason: string}> = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, {withFileTypes: true})
    // The walk is intentionally sequential: a parallel Promise.all recursion would
    // open every source file across the tree at once and risk EMFILE on large repos.
    /* eslint-disable no-await-in-loop -- bounded sequential FS walk by design */
    for (const entry of entries) {
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        // Skip ignore-listed and hidden directories outright (never descend).
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(full)
        continue
      }

      if (!entry.isFile()) continue

      const rel = asRelativePath(rootDir, full)

      // Dotfiles and known lockfiles are noise, not source.
      const initialSkip = skipReason(rel)
      if (initialSkip) {
        skipped.push({path: rel, reason: initialSkip})
        continue
      }

      const {size} = await stat(full)
      if (size > maxBytes) {
        skipped.push({path: rel, reason: `too large (${size} bytes > ${maxBytes})`})
        continue
      }

      const buffer = await readFile(full)
      if (looksBinary(buffer)) {
        skipped.push({path: rel, reason: 'binary'})
        continue
      }

      files.push({content: buffer.toString('utf8'), fileName: rel})
    }
    /* eslint-enable no-await-in-loop */
  }

  await walk(rootDir)
  files.sort((a, b) => a.fileName.localeCompare(b.fileName))
  return {files, skipped}
}
