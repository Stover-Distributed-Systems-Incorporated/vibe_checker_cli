import {expect} from 'chai'
import {execFile} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'

import {readGitCoordinate} from '../../src/lib/git.js'

const run = promisify(execFile)

async function initRepo(dir: string): Promise<void> {
  await run('git', ['-C', dir, 'init', '-q'])
  await run('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Test'])
  await run('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
}

describe('readGitCoordinate', () => {
  it('returns all-null/false outside a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vc-nogit-'))
    try {
      const coord = await readGitCoordinate(dir)
      expect(coord.sha).to.equal(null)
      expect(coord.branch).to.equal(null)
      expect(coord.dirty).to.equal(false)
    } finally {
      await rm(dir, {force: true, recursive: true})
    }
  })

  it('reports sha, branch, and clean/dirty state inside a repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vc-git-'))
    try {
      await initRepo(dir)
      await writeFile(join(dir, 'a.txt'), 'hello')
      await run('git', ['-C', dir, 'add', '.'])
      await run('git', ['-C', dir, 'commit', '-q', '-m', 'init'])

      const clean = await readGitCoordinate(dir)
      expect(clean.sha).to.match(/^[0-9a-f]{40}$/)
      expect(clean.branch).to.be.a('string')
      expect(clean.dirty).to.equal(false)

      // An uncommitted edit flips dirty to true; the base sha is unchanged.
      await writeFile(join(dir, 'a.txt'), 'changed')
      const dirty = await readGitCoordinate(dir)
      expect(dirty.dirty).to.equal(true)
      expect(dirty.sha).to.equal(clean.sha)
    } finally {
      await rm(dir, {force: true, recursive: true})
    }
  })
})
