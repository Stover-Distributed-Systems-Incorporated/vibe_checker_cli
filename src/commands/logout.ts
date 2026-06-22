import {select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'

import {logoutSession} from '../lib/api.js'
import {getBaseUrl} from '../lib/config.js'
import {clearCredentials, loadCredentials} from '../lib/credentials.js'

export default class Logout extends Command {
  static description = 'Log out and revoke your session(s) on the server.'
  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --all',
    '<%= config.bin %> <%= command.id %> --this-device',
  ]
  static flags = {
    all: Flags.boolean({
      description: 'Revoke every session (log out of all devices)',
      exclusive: ['this-device'],
    }),
    'this-device': Flags.boolean({
      description: 'Revoke only the current session',
      exclusive: ['all'],
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Logout)

    const creds = await loadCredentials(this.config.configDir)
    if (!creds) {
      this.log('Not logged in.')
      return
    }

    let scope: 'all' | 'current'
    if (flags.all) {
      scope = 'all'
    } else if (flags['this-device']) {
      scope = 'current'
    } else {
      scope = await select<'all' | 'current'>({
        choices: [
          {name: 'This device only', value: 'current'},
          {name: 'All devices (revoke every session)', value: 'all'},
        ],
        message: 'Log out of which sessions?',
      })
    }

    try {
      await logoutSession(getBaseUrl(), creds.refresh_token, scope)
    } catch {
      // Server-side revocation failure must not prevent local credential cleanup.
    }

    await clearCredentials(this.config.configDir)
    this.log(scope === 'all' ? 'Logged out of all devices.' : 'Logged out.')
  }
}
