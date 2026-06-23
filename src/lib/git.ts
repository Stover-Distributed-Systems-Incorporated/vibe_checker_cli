import {execFile} from 'node:child_process'

/** The repo's git state at map time, used to anchor a map snapshot to a commit. */
export interface GitCoordinate {
  /** Current branch, or null when detached / unavailable. */
  branch: null | string
  /** True when the working tree has uncommitted changes. */
  dirty: boolean
  /** HEAD commit sha, or null outside a git repo (or an empty repo with no commits). */
  sha: null | string
}

/** Run a git subcommand in rootDir, resolving to trimmed stdout or null on any error. */
function git(rootDir: string, args: string[]): Promise<null | string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', rootDir, ...args],
      {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024},
      (error, stdout) => {
        resolve(error ? null : stdout.trim())
      },
    )
  })
}

/**
 * Best-effort git state for the repo at rootDir. Returns all-null/false outside a git
 * repo, in an empty repo, or when git is unavailable — never throws, so mapping a
 * non-git directory still works; it just isn't anchored to a commit (no snapshot).
 */
export async function readGitCoordinate(rootDir: string): Promise<GitCoordinate> {
  const sha = await git(rootDir, ['rev-parse', 'HEAD'])
  if (!sha) return {branch: null, dirty: false, sha: null}

  const branch = await git(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = await git(rootDir, ['status', '--porcelain'])
  return {
    // 'HEAD' means detached — not a branch name we can use.
    branch: branch && branch !== 'HEAD' ? branch : null,
    dirty: status !== null && status.length > 0,
    sha,
  }
}
