import {input, password, select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'

import {createProject, ensureAccessToken, importMap, listProjects} from '../lib/api.js'
import {getBaseUrl} from '../lib/config.js'
import {loadProviderKey, saveProviderKey} from '../lib/credentials.js'
import {crawlProject, listProviders} from '../lib/opencode.js'
import {findVibeConfig, readVibeConfig, writeVibeConfig} from '../lib/vibeconfig.js'

export default class Map extends Command {
  static description =
    'Crawl the current project with OpenCode and map it into a Vibe Checker project (modules + functions).'
  static examples = ['<%= config.bin %> <%= command.id %>']
  static flags = {
    model: Flags.string({char: 'm', description: 'Model ID to use (skips the model prompt)'}),
    project: Flags.string({char: 'p', description: 'Project id to map into (skips the first-run prompt)'}),
    provider: Flags.string({description: 'Provider ID to use (skips the provider prompt)'}),
    verbose: Flags.boolean({char: 'v', default: false, description: 'Stream live OpenCode events and detailed errors'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Map)
    const baseUrl = getBaseUrl()
    const {configDir} = this.config

    // Fail fast before the (potentially long) crawl if the user isn't authenticated.
    try {
      await ensureAccessToken(baseUrl, configDir)
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Authentication required.')
    }

    let projectId: string
    let projectName: string
    let providerId: string
    let model: string
    let rootDir: string

    const existingPath = findVibeConfig(process.cwd())
    if (existingPath) {
      const config = await readVibeConfig(existingPath)
      projectId = config.projectId
      projectName = config.projectName
      providerId = flags.provider ?? config.providerId
      model = flags.model ?? config.model
      rootDir = config.rootDir
    } else {
      // First run: resolve project, provider, API key, and model interactively.
      rootDir = process.cwd()
      const resolved = await this.resolveProject(baseUrl, configDir, flags.project)
      projectId = resolved.projectId
      projectName = resolved.projectName
      ;({model, providerId} = await this.resolveProviderAndModel(configDir, flags.provider, flags.model))

      const written = await writeVibeConfig(rootDir, {
        model,
        projectId,
        projectName,
        providerId,
        rootDir,
        updatedAt: new Date().toISOString(),
        version: 1,
      })
      this.log(`Saved project settings to ${written}.`)
    }

    // Load the stored key for this provider (prompted during first run, saved there).
    const apiKey = await loadProviderKey(configDir, providerId)
    if (!apiKey) {
      this.error(`No API key found for provider "${providerId}". Delete .vibe-checker and run map again to re-configure.`)
    }

    this.log(`Crawling ${rootDir} with ${providerId}/${model} — this can take a few minutes…`)
    let map
    try {
      map = await crawlProject(
        rootDir,
        {apiKey, modelID: model, providerID: providerId},
        {log: (message) => this.logToStderr(message), verbose: flags.verbose},
      )
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'OpenCode crawl failed.')
    }

    this.log(`Mapped ${map.modules.length} module(s). Importing into "${projectName}"…`)
    try {
      const summary = await importMap(baseUrl, configDir, projectId, map.modules)
      this.log(
        `Done. Modules: +${summary.created_modules} new, ${summary.updated_modules} updated. ` +
          `Functions: +${summary.created_functions} new, ${summary.updated_functions} updated.`,
      )
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Import failed.')
    }

    // Refresh the timestamp on a subsequent run.
    if (existingPath) {
      await writeVibeConfig(rootDir, {
        model,
        projectId,
        projectName,
        providerId,
        rootDir,
        updatedAt: new Date().toISOString(),
        version: 1,
      })
    }
  }

  /** Pick an existing project (by flag or prompt) or create a new one. */
  private async resolveProject(
    baseUrl: string,
    configDir: string,
    projectFlag?: string,
  ): Promise<{projectId: string; projectName: string}> {
    const projects = await listProjects(baseUrl, configDir)

    if (projectFlag) {
      const match = projects.find((p) => p._id === projectFlag || p.name === projectFlag)
      if (!match) this.error(`No project matching "${projectFlag}" was found.`)
      return {projectId: match._id, projectName: match.name}
    }

    const CREATE = '__create__'
    const choice = await select({
      choices: [
        ...projects.map((p) => ({name: p.name, value: p._id})),
        {name: '➕ Create a new project', value: CREATE},
      ],
      message: 'Map into which project?',
    })

    if (choice !== CREATE) {
      const match = projects.find((p) => p._id === choice)!
      return {projectId: match._id, projectName: match.name}
    }

    const name = await input({message: 'New project name:'})
    const desc = await input({message: 'Project description:'})
    const {project_id: newId} = await createProject(baseUrl, configDir, name, desc)
    return {projectId: newId, projectName: name}
  }

  /** Prompt for provider → API key → model. Saves the key to the config dir. */
  private async resolveProviderAndModel(
    configDir: string,
    providerFlag?: string,
    modelFlag?: string,
  ): Promise<{model: string; providerId: string}> {
    // Ask for the provider ID first so we can spin up OpenCode with the right key.
    const providerId =
      providerFlag ??
      (await input({
        message: 'Provider ID (e.g. anthropic, openai, google):',
      }))

    const apiKey = await password({mask: true, message: `API key for ${providerId}:`})

    // Fetch that provider's model list from OpenCode.
    this.log('Fetching available models…')
    let providers
    try {
      providers = await listProviders(providerId, apiKey)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.error(`Could not fetch model list: ${reason}`)
    }

    const provider = providers.find((p) => p.id === providerId)
    if (!provider || provider.models.length === 0) {
      this.error(`No models found for provider "${providerId}". Check your provider ID and API key.`)
    }

    const modelId =
      modelFlag ??
      (await select({
        choices: provider.models.map((m) => ({name: `${m.name} (${m.id})`, value: m.id})),
        message: `Select a model for ${provider.name}:`,
      }))

    // Persist the key so re-runs don't prompt again.
    await saveProviderKey(configDir, providerId, apiKey)

    return {model: modelId, providerId}
  }
}
