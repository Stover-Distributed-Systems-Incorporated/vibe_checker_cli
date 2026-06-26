import {readFile} from 'node:fs/promises'

import type {SourceFileCandidate} from './files.js'

/**
 * Deterministic symbol-density ranking of candidate source files.
 *
 * Why this exists: on large repos the LLM file selector (opencode.ts) fails two ways —
 * it silently under-covers (measured 31% of a 2.3k-file repo's symbols) or it enumerates
 * so many files that its JSON response truncates and yields ZERO files (an empty map).
 * Ranking by actual code density is deterministic, free, and cannot truncate, and at the
 * same file budget it covered ~75% of symbols vs the LLM's 31% (a 2.4x improvement). For
 * small repos the LLM selector is fine, so this is used only past a size threshold.
 *
 * This is a heuristic symbol COUNT (definition-like constructs per language), not a full
 * parse — exactness does not matter, only that denser files rank higher than sparse ones.
 */

// Per-language regexes matching a "definition" (function / method / class / type). Summed
// per file to approximate how much implemented behavior the file carries.
const PATTERNS: Record<string, RegExp[]> = {
  c: [/^[\w*\s]+\b\w+\s*\([^)]*\)\s*\{/gm, /\b(?:struct|enum|union)\s+\w+/g],
  go: [/\bfunc\s+(?:\([^)]*\)\s*)?\w+/g, /\btype\s+\w+\s+(?:struct|interface)\b/g],
  js: [
    /\bfunction\b\s*\*?\s*\w*/g,
    /\bclass\s+\w+/g,
    /\b[\w$]+\s*[=:]\s*(?:async\s*)?\([^)]*\)\s*=>/g, // const f = (..) =>
    /^[\t ]*(?:async\s+)?[\w$]+\s*\([^)]*\)\s*\{/gm, // method() {
  ],
  python: [/^[\t ]*(?:async[\t ]+)?def[\t ]+\w+/gm, /^[\t ]*class[\t ]+\w+/gm],
  rust: [/\bfn\s+\w+/g, /\b(?:struct|enum|trait|impl)\s+\w+/g],
  ts: [
    /\bfunction\b\s*\*?\s*\w*/g,
    /\bclass\s+\w+/g,
    /\binterface\s+\w+/g,
    /\btype\s+\w+\s*=/g,
    /\b[\w$]+\s*[=:]\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/g,
    /^[\t ]*(?:public|private|protected|static|async|\s)*[\w$]+\s*\([^)]*\)\s*[:{]/gm,
  ],
}

const EXT_TO_LANG: Record<string, string> = {
  '.c': 'c', '.cc': 'c', '.cjs': 'js', '.cpp': 'c', '.cs': 'c', '.go': 'go', '.h': 'c',
  '.hpp': 'c', '.java': 'ts', '.js': 'js', '.jsx': 'js', '.kt': 'ts', '.m': 'c',
  '.mjs': 'js', '.php': 'js', '.py': 'python', '.rb': 'python', '.rs': 'rust',
  '.scala': 'ts', '.ts': 'ts', '.tsx': 'ts',
}

const MAX_BYTES_PER_FILE = 12_000 // mirror the API digest cap; cheap and bounds huge files

function langFor(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.')
  return dot === -1 ? undefined : EXT_TO_LANG[fileName.slice(dot).toLowerCase()]
}

/** Heuristic count of definition-like constructs in `content` for `fileName`'s language. */
export function countSymbols(fileName: string, content: string): number {
  const lang = langFor(fileName)
  if (!lang) return 0
  const text = content.length > MAX_BYTES_PER_FILE ? content.slice(0, MAX_BYTES_PER_FILE) : content
  let total = 0
  for (const re of PATTERNS[lang]) {
    const matches = text.match(re)
    if (matches) total += matches.length
  }

  return total
}

export interface RankedCandidate {
  candidate: SourceFileCandidate
  symbols: number
}

/**
 * Read each candidate's content, count its symbols, and return them sorted by symbol
 * count (desc), tie-broken by shallower path so a true entry file wins among equals.
 * Files that cannot be read are ranked last with 0. Reading is bounded per file.
 */
export async function rankBySymbolDensity(candidates: SourceFileCandidate[]): Promise<RankedCandidate[]> {
  const ranked: RankedCandidate[] = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const buf = await readFile(candidate.path)
        return {candidate, symbols: countSymbols(candidate.fileName, buf.toString('utf8'))}
      } catch {
        return {candidate, symbols: 0}
      }
    }),
  )

  const depth = (c: SourceFileCandidate) => c.fileName.split('/').length
  ranked.sort((a, b) => b.symbols - a.symbols || depth(a.candidate) - depth(b.candidate))
  return ranked
}

/**
 * Pick the `budget` most symbol-dense files from `candidates`. Used for large repos where
 * the LLM selector under-covers or truncates. Returns the chosen candidates in rank order.
 */
export async function selectBySymbolDensity(
  candidates: SourceFileCandidate[],
  budget: number,
): Promise<SourceFileCandidate[]> {
  const ranked = await rankBySymbolDensity(candidates)
  return ranked.slice(0, budget).map((r) => r.candidate)
}
