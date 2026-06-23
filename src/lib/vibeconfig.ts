import {existsSync} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'

export interface VibeConfig {
  /** Informational: the HEAD sha of the most recent map run, when mapped inside a git repo. */
  lastMappedSha?: null | string
  model: string
  projectId: string
  projectName: string
  providerId: string
  rootDir: string
  updatedAt: string
  version: number
}

export const VIBE_CONFIG_FILE = '.vibe-checker'

/** Walk up from startDir to locate an existing .vibe-checker file, or null if none. */
export function findVibeConfig(startDir: string): null | string {
  let dir = startDir
  while (dir) {
    const candidate = join(dir, VIBE_CONFIG_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

export async function readVibeConfig(path: string): Promise<VibeConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as VibeConfig
}

/** Write the .vibe-checker file into dir and return its path. */
export async function writeVibeConfig(dir: string, config: VibeConfig): Promise<string> {
  const path = join(dir, VIBE_CONFIG_FILE)
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return path
}
