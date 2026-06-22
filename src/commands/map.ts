import {input, select} from '@inquirer/prompts'
import {Args, Command, Flags} from '@oclif/core'
import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import {createProject, ensureAccessToken, listProjects, mapFile} from '../lib/api.js'
import {getBaseUrl} from '../lib/config.js'
import {findVibeConfig, readVibeConfig, writeVibeConfig} from '../lib/vibeconfig.js'

export default class Map extends Command {
  static args = {
    file: Args.string({description: 'Path to the source file to map', required: false}),
  }
  static description = 'Map a single source file into a Vibe Checker module (functions + flow).'
static examples = ['<%= config.bin %> <%= command.id %> <file-path>']
static flags = {
    project: Flags.string({char: 'p', description: 'Project id to map into (skips the first-run prompt)'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Map)
    const {file} = args

    if (!file) {
      // "make it so that the map function does essentially nothing without a specified file"
      return
    }

    const baseUrl = getBaseUrl()
    const {configDir} = this.config

    // Fail fast if the user isn't authenticated.
    try {
      await ensureAccessToken(baseUrl, configDir)
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Authentication required.')
    }

    // Check if the file exists locally and read its contents.
    const filePath = resolve(process.cwd(), file)
    if (!existsSync(filePath)) {
      this.error(`File not found: ${file}`)
    }

    let fileContent: string
    try {
      fileContent = await readFile(filePath, 'utf8')
    } catch (error) {
      this.error(`Could not read file: ${error instanceof Error ? error.message : String(error)}`)
    }

    let projectId: string
    let projectName: string
    let rootDir: string

    const existingPath = findVibeConfig(process.cwd())
    if (existingPath) {
      const config = await readVibeConfig(existingPath)
      projectId = config.projectId
      projectName = config.projectName
      rootDir = config.rootDir
    } else {
      // First run: resolve project.
      rootDir = process.cwd()
      const resolved = await this.resolveProject(baseUrl, configDir, flags.project)
      projectId = resolved.projectId
      projectName = resolved.projectName

      const written = await writeVibeConfig(rootDir, {
        model: 'none',
        projectId,
        projectName,
        providerId: 'none',
        rootDir,
        updatedAt: new Date().toISOString(),
        version: 1,
      })
      this.log(`Saved project settings to ${written}.`)
    }

    this.log(`Mapping "${file}" into project "${projectName}" — analyzing with LLM…`)
    try {
      const summary = await mapFile(baseUrl, configDir, {
        fileContent,
        fileName: file,
        projectId,
      })
      this.log(
        `Done. Modules: +${summary.created_modules} new, ${summary.updated_modules} updated. ` +
          `Functions: +${summary.created_functions} new, ${summary.updated_functions} updated.`,
      )
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Mapping failed.')
    }

    // Refresh the timestamp on a subsequent run.
    if (existingPath) {
      await writeVibeConfig(rootDir, {
        model: 'none',
        projectId,
        projectName,
        providerId: 'none',
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
}
