import {expect} from 'chai'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {SourceFileCandidate} from '../../src/lib/files.js'

import {countSymbols, rankBySymbolDensity, selectBySymbolDensity} from '../../src/lib/symbolrank.js'

async function candidate(dir: string, name: string, body: string): Promise<SourceFileCandidate> {
  const path = join(dir, name)
  await writeFile(path, body)
  return {fileName: name, path, size: body.length}
}

describe('symbolrank', () => {
  describe('countSymbols', () => {
    it('counts python defs and classes', () => {
      const src = 'class A:\n    def a(self):\n        pass\n    def b(self):\n        pass\ndef top():\n    pass\n'
      expect(countSymbols('m.py', src)).to.equal(4) // class A, a, b, top
    })

    it('counts typescript functions, classes, interfaces, and arrows', () => {
      const src = 'export function f() {}\nclass C {}\ninterface I {}\nconst g = (x: number) => x\n'
      expect(countSymbols('m.ts', src)).to.be.greaterThan(3)
    })

    it('returns 0 for unsupported extensions', () => {
      expect(countSymbols('data.json', '{"a": 1}')).to.equal(0)
    })

    it('a dense file scores higher than a sparse one', () => {
      const dense = Array.from({length: 20}, (_, i) => `def f${i}():\n    pass`).join('\n')
      const sparse = 'x = 1\ny = 2\nz = x + y\n'
      expect(countSymbols('d.py', dense)).to.be.greaterThan(countSymbols('s.py', sparse))
    })
  })

  describe('rankBySymbolDensity / selectBySymbolDensity', () => {
    it('ranks the densest file first and respects the budget', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vc-rank-'))
      try {
        const dense = await candidate(dir, 'dense.py', 'def a():\n pass\ndef b():\n pass\ndef c():\n pass\n')
        const mid = await candidate(dir, 'mid.py', 'def a():\n pass\n')
        const sparse = await candidate(dir, 'sparse.py', 'x = 1\n')

        const ranked = await rankBySymbolDensity([sparse, mid, dense])
        expect(ranked.map((r) => r.candidate.fileName)).to.deep.equal(['dense.py', 'mid.py', 'sparse.py'])

        const top2 = await selectBySymbolDensity([sparse, mid, dense], 2)
        expect(top2.map((c) => c.fileName)).to.deep.equal(['dense.py', 'mid.py'])
      } finally {
        await rm(dir, {force: true, recursive: true})
      }
    })

    it('ranks unreadable files last instead of throwing', async () => {
      const missing: SourceFileCandidate = {fileName: 'gone.py', path: '/nope/gone.py', size: 10}
      const dir = await mkdtemp(join(tmpdir(), 'vc-rank2-'))
      try {
        const real = await candidate(dir, 'real.py', 'def a():\n pass\n')
        const ranked = await rankBySymbolDensity([missing, real])
        expect(ranked[0].candidate.fileName).to.equal('real.py')
        expect(ranked[1].symbols).to.equal(0)
      } finally {
        await rm(dir, {force: true, recursive: true})
      }
    })
  })
})
