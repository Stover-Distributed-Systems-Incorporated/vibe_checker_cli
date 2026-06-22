import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('credits', () => {
  it('credits the major tools the CLI is built on', async () => {
    const {stdout} = await runCommand('credits')
    expect(stdout).to.contain('OpenCode')
    expect(stdout).to.contain('oclif')
    expect(stdout).to.contain('Node.js')
  })

  it('lists runtime dependencies with their versions', async () => {
    const {stdout} = await runCommand('credits')
    // Non-highlighted runtime deps are listed by their raw package name.
    expect(stdout).to.contain('@oclif/plugin-')
    // Versions are rendered in parentheses, e.g. "OpenCode (^1.17.9)".
    expect(stdout).to.match(/\(\^?\d/)
  })

  it('exits cleanly', async () => {
    const {error} = await runCommand('credits')
    expect(error).to.be.undefined
  })
})
