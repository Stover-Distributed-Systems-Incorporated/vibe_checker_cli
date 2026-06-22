import {readdir, readFile, stat} from 'node:fs/promises'
import {extname, join, relative, sep} from 'node:path'

export interface SourceFile {
  content: string
  /** Path relative to the walked root (POSIX separators), used as the module's file_name. */
  fileName: string
}

export interface CollectResult {
  files: SourceFile[]
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

      const rel = relative(rootDir, full).split(sep).join('/')

      // Dotfiles and known lockfiles are noise, not source.
      if (entry.name.startsWith('.') || IGNORE_FILES.has(entry.name)) {
        skipped.push({path: rel, reason: 'ignored file'})
        continue
      }

      if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        skipped.push({path: rel, reason: 'unsupported extension'})
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
