import {Command} from '@oclif/core'

/** A tool or library worth calling out by name, with what it does for us and where to find it. */
interface Credit {
  /** npm package name, used to resolve the installed version from package.json when present. */
  pkg?: string
  /** What this project relies on it for. */
  role: string
  /** Display name. */
  title: string
  /** Project homepage. */
  url: string
}

// The headline tools that make VibeChecker possible — the engine, the CLI framework,
// and the runtime. These are credited first and in full, regardless of dependency order.
const MAJOR_TOOLS: Credit[] = [
  {
    pkg: '@opencode-ai/sdk',
    role: 'Powers code crawling, file selection, and the AI mapping engine.',
    title: 'OpenCode',
    url: 'https://opencode.ai',
  },
  {
    pkg: '@oclif/core',
    role: 'The command-line framework this CLI is built on.',
    title: 'oclif',
    url: 'https://oclif.io',
  },
  {
    pkg: '@inquirer/prompts',
    role: 'Interactive terminal prompts (login, logout, selections).',
    title: 'Inquirer',
    url: 'https://github.com/SBoudrias/Inquirer.js',
  },
  {
    pkg: 'keytar',
    role: 'Secure credential storage in the OS keychain.',
    title: 'keytar',
    url: 'https://github.com/atom/node-keytar',
  },
  {
    role: 'The JavaScript runtime this CLI runs on.',
    title: 'Node.js',
    url: 'https://nodejs.org',
  },
  {
    role: 'The typed language the CLI is written in.',
    title: 'TypeScript',
    url: 'https://www.typescriptlang.org',
  },
]

export default class Credits extends Command {
  static description = 'Show the open-source tools and dependencies that power VibeChecker.'
  static examples = ['<%= config.bin %> <%= command.id %>']

  async run(): Promise<void> {
    await this.parse(Credits)

    const pjson = this.config.pjson as {dependencies?: Record<string, string>}
    const dependencies = pjson.dependencies ?? {}

    this.log('VibeChecker is built on the work of the open-source community.')
    this.log('Heartfelt thanks to the projects and maintainers below.\n')

    this.log('Major tools')
    this.log('-----------')
    for (const credit of MAJOR_TOOLS) {
      const version = credit.pkg ? dependencies[credit.pkg] : undefined
      const versionLabel = version ? ` (${version})` : ''
      this.log(`• ${credit.title}${versionLabel}`)
      this.log(`    ${credit.role}`)
      this.log(`    ${credit.url}`)
    }

    // Surface every remaining runtime dependency so nothing we ship goes uncredited.
    const highlighted = new Set(MAJOR_TOOLS.map((c) => c.pkg).filter(Boolean) as string[])
    const remaining = Object.keys(dependencies)
      .filter((name) => !highlighted.has(name))
      .sort((a, b) => a.localeCompare(b))

    if (remaining.length > 0) {
      this.log('\nOther dependencies')
      this.log('------------------')
      for (const name of remaining) {
        this.log(`• ${name} (${dependencies[name]})`)
      }
    }

    this.log('\nThank you to every maintainer and contributor. ♥')
  }
}
