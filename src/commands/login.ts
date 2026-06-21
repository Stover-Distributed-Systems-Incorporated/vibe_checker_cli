/* eslint-disable camelcase -- credential fields mirror the API's snake_case JSON contract */
import {input, password} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'

import {signin} from '../lib/api.js'
import {getBaseUrl} from '../lib/config.js'
import {saveCredentials} from '../lib/credentials.js'

export default class Login extends Command {
  static description = 'Log in to Vibe Checker and store an authenticated session.'
  static examples = ['<%= config.bin %> <%= command.id %>']
  static flags = {
    username: Flags.string({char: 'u', description: 'Username or email (skips the prompt)'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Login)

    const identifier = flags.username ?? (await input({message: 'Username or email:'}))
    const pwd = await password({mask: true, message: 'Password:'})

    try {
      const tokens = await signin(getBaseUrl(), identifier, pwd)
      await saveCredentials(this.config.configDir, {
        access_token: tokens.access_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        refresh_token: tokens.refresh_token,
      })
      this.log(`Logged in as ${identifier}.`)
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Login failed.')
    }
  }
}
