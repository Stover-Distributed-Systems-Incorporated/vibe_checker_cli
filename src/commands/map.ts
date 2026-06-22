import {input, select} from '@inquirer/prompts'
import {Args, Command, Flags} from '@oclif/core'
import {existsSync} from 'node:fs'
import {readFile, stat} from 'node:fs/promises'
import {resolve} from 'node:path'

import type {MapFilesSummary} from '../lib/api.js'

import {createProject, ensureAccessToken, listProjects, mapFile, mapFiles} from '../lib/api.js'
import {getBaseUrl} from '../lib/config.js'
import {collectSourceFiles} from '../lib/files.js'
import {findVibeConfig, readVibeConfig, writeVibeConfig} from '../lib/vibeconfig.js'

/** The resolved auth/project context shared by both mapping paths. */
interface MapContext {
  baseUrl: string
  configDir: string
  projectId: string
  projectName: string
}

export default class Map extends Command {
  static args = {
    file: Args.string({description: 'Path to a source file, or a directory to map recursively', required: false}),
  }
  static description = 'Map a source file — or an entire directory — into Vibe Checker modules (functions + flow).'
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

    // Resolve the target locally — it may be a single file or a whole directory.
    const targetPath = resolve(process.cwd(), file)
    if (!existsSync(targetPath)) {
      this.error(`Path not found: ${file}`)
    }

    const isDirectory = (await stat(targetPath)).isDirectory()

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

    const ctx: MapContext = {baseUrl, configDir, projectId, projectName}
    await (isDirectory ? this.mapDirectory(ctx, targetPath) : this.mapSingleFile(ctx, file, targetPath))

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

  /** Collect, filter, and batch-map every source file under a directory. */
  private async mapDirectory(ctx: MapContext, dirPath: string): Promise<void> {
    const {files, skipped} = await collectSourceFiles(dirPath)
    if (files.length === 0) {
      this.error(`No mappable source files found under "${dirPath}".`)
    }

    this.log(
      `Mapping ${files.length} file${files.length === 1 ? '' : 's'} into project "${ctx.projectName}" ` +
        `(${skipped.length} skipped) — analyzing with LLM…`,
    )

    let summary: MapFilesSummary
    try {
      summary = await mapFiles(ctx.baseUrl, ctx.configDir, {files, projectId: ctx.projectId})
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Mapping failed.')
    }

    this.log(
      `Done. Mapped ${summary.mapped_count}/${files.length} file${files.length === 1 ? '' : 's'}. ` +
        `Modules: +${summary.created_modules} new, ${summary.updated_modules} updated. ` +
        `Functions: +${summary.created_functions} new, ${summary.updated_functions} updated.`,
    )

    if (summary.failed_count > 0) {
      this.log(`${summary.failed_count} file${summary.failed_count === 1 ? '' : 's'} failed to map:`)
      for (const f of summary.failed) {
        this.log(`  ✗ ${f.file_name}: ${f.error}`)
      }
    }
  }

  /** Read and map a single source file (the original one-file-per-call behavior). */
  private async mapSingleFile(ctx: MapContext, fileName: string, filePath: string): Promise<void> {
    let fileContent: string
    try {
      fileContent = await readFile(filePath, 'utf8')
    } catch (error) {
      this.error(`Could not read file: ${error instanceof Error ? error.message : String(error)}`)
    }

    this.log(`Mapping "${fileName}" into project "${ctx.projectName}" — analyzing with LLM…`)
    try {
      const summary = await mapFile(ctx.baseUrl, ctx.configDir, {fileContent, fileName, projectId: ctx.projectId})
      this.log(
        `Done. Modules: +${summary.created_modules} new, ${summary.updated_modules} updated. ` +
          `Functions: +${summary.created_functions} new, ${summary.updated_functions} updated.`,
      )
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Mapping failed.')
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
