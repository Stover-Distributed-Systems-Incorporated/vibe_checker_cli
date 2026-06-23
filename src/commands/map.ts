import {input, password, select} from '@inquirer/prompts'
import {Args, Command, Flags} from '@oclif/core'
import {existsSync} from 'node:fs'
import {readFile, stat} from 'node:fs/promises'
import {resolve} from 'node:path'

import type {MapFilesSummary} from '../lib/api.js'

import {createProject, ensureAccessToken, getUserPlan, listProjects, mapFile, mapFiles} from '../lib/api.js'
import {getBaseUrl} from '../lib/config.js'
import {
  collectSourceFileCandidates,
  readSourceFileCandidates,
  sha256,
  type SourceFile,
} from '../lib/files.js'
import {type GitCoordinate, readGitCoordinate} from '../lib/git.js'
import {type EngineModel, selectProjectFiles} from '../lib/opencode.js'
import {findVibeConfig, readVibeConfig, writeVibeConfig} from '../lib/vibeconfig.js'

/** The resolved auth/project context shared by both mapping paths. */
interface MapContext {
  baseUrl: string
  configDir: string
  git: GitCoordinate
  projectId: string
  projectName: string
}

export default class Map extends Command {
  static args = {
    file: Args.string({description: 'Path to a source file, or a directory to map recursively', required: false}),
  }
  static description = 'Map a source file or directory — or use OpenCode to quickly select the current project’s important source files.'
  static examples = ['<%= config.bin %> <%= command.id %> <file-path>', '<%= config.bin %> <%= command.id %>']
  static flags = {
    project: Flags.string({char: 'p', description: 'Project id to map into (skips the first-run prompt)'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Map)
    const {file} = args

    const baseUrl = getBaseUrl()
    const {configDir} = this.config

    // Resolve the repo's git state once so the API can anchor a snapshot to this commit
    // and skip re-mapping unchanged files. All-null outside a git repo — mapping still works.
    const git = await readGitCoordinate(process.cwd())

    // Fail fast if the user isn't authenticated.
    try {
      await ensureAccessToken(baseUrl, configDir)
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Authentication required.')
    }

    // A target maps exactly as before. Without one, build a local source manifest
    // and give OpenCode a single, tool-free turn to choose the important files.
    const targetPath = file ? resolve(process.cwd(), file) : undefined
    if (targetPath && !existsSync(targetPath)) this.error(`Path not found: ${file}`)
    const isDirectory = targetPath ? (await stat(targetPath)).isDirectory() : false

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
        lastMappedSha: git.sha,
        model: 'none',
        projectId,
        projectName,
        providerId: 'none',
        rootDir,
        updatedAt: new Date().toISOString(),
        version: 2,
      })
      this.log(`Saved project settings to ${written}.`)
    }

    const ctx: MapContext = {baseUrl, configDir, git, projectId, projectName}
    if (file) {
      await (isDirectory ? this.mapDirectory(ctx, targetPath!) : this.mapSingleFile(ctx, file, targetPath!))
    } else {
      await this.mapSelectedFiles(ctx, rootDir)
    }

    // Refresh the timestamp on a subsequent run.
    if (existingPath) {
      await writeVibeConfig(rootDir, {
        lastMappedSha: git.sha,
        model: 'none',
        projectId,
        projectName,
        providerId: 'none',
        rootDir,
        updatedAt: new Date().toISOString(),
        version: 2,
      })
    }
  }

  /** Collect, filter, and batch-map every source file under a directory. */
  private async mapDirectory(ctx: MapContext, dirPath: string): Promise<void> {
    const candidates = await collectSourceFileCandidates(dirPath)
    const {files, skipped} = await readSourceFileCandidates(candidates.files)
    if (files.length === 0) {
      this.error(`No mappable source files found under "${dirPath}".`)
    }

    await this.mapSourceFiles(ctx, files, candidates.skipped.length + skipped.length)
  }

  /** Build a local source manifest, then let OpenCode rank it in one tool-free model turn. */
  private async mapSelectedFiles(ctx: MapContext, rootDir: string): Promise<void> {
    this.log('Finding eligible project source files locally…')
    const candidates = await collectSourceFileCandidates(rootDir)
    if (candidates.files.length === 0) {
      this.error('No eligible project source files found.')
    }

    this.log(
      `Found ${candidates.files.length} eligible source file${candidates.files.length === 1 ? '' : 's'} ` +
        `(${candidates.skipped.length} excluded${candidates.gitignoreApplied ? '; Git ignore rules applied' : ''}).`,
    )
    const model = await this.resolveEngineModel(ctx)
    this.log('Asking OpenCode to prioritize the project files…')

    let selected: string[]
    try {
      selected = (await selectProjectFiles(rootDir, model, candidates.files)).files
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'OpenCode file selection failed.')
    }

    const byName = new globalThis.Map(candidates.files.map((source) => [source.fileName, source]))
    const chosen = selected.flatMap((name) => {
      const source = byName.get(name)
      return source ? [source] : []
    })
    if (chosen.length === 0) {
      this.error('OpenCode did not select any eligible source files to map.')
    }

    this.log(
      `OpenCode selected ${chosen.length} eligible file${chosen.length === 1 ? '' : 's'} ` +
        `(${selected.length - chosen.length} ignored by local safety filters).`,
    )
    for (const source of chosen) this.log(`  • ${source.fileName}`)

    const {files, skipped} = await readSourceFileCandidates(chosen)
    if (files.length === 0) this.error('The selected source files could not be read.')
    await this.mapSourceFiles(ctx, files, candidates.skipped.length + skipped.length)
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
      const summary = await mapFile(ctx.baseUrl, ctx.configDir, {
        contentHash: sha256(fileContent),
        fileContent,
        fileName,
        git: ctx.git,
        projectId: ctx.projectId,
      })
      this.log(
        `Done. Modules: +${summary.created_modules} new, ${summary.updated_modules} updated. ` +
          `Functions: +${summary.created_functions} new, ${summary.updated_functions} updated.`,
      )
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Mapping failed.')
    }
  }

  /** Map an already-filtered collection of source files through the batch API. */
  private async mapSourceFiles(ctx: MapContext, files: SourceFile[], skippedCount = 0): Promise<void> {
    // A large map used to be one long request that could hit a gateway 504. Send the
    // files in small sequential batches instead: each request stays short, progress is
    // visible, and modules show up in the web UI as each batch lands. The git coordinate
    // is sent only on the final batch, so the snapshot is frozen once over the full map.
    const BATCH_SIZE = 10
    const batches: SourceFile[][] = []
    for (let i = 0; i < files.length; i += BATCH_SIZE) batches.push(files.slice(i, i + BATCH_SIZE))

    this.log(
      `Mapping ${files.length} file${files.length === 1 ? '' : 's'} into project "${ctx.projectName}" ` +
        `(${skippedCount} skipped) in ${batches.length} batch${batches.length === 1 ? '' : 'es'} — analyzing with LLM…`,
    )

    const totals = {createdFunctions: 0, createdModules: 0, mapped: 0, reused: 0, updatedFunctions: 0, updatedModules: 0}
    const failed: Array<{error: string; file_name: string}> = []

    for (let i = 0; i < batches.length; i++) {
      const isLast = i === batches.length - 1
      let summary: MapFilesSummary
      try {
        // eslint-disable-next-line no-await-in-loop -- batches are intentionally sequential: it keeps each request short and avoids racing on module creation.
        summary = await mapFiles(ctx.baseUrl, ctx.configDir, {
          files: batches[i],
          git: isLast ? ctx.git : undefined,
          projectId: ctx.projectId,
        })
      } catch (error) {
        this.error(error instanceof Error ? error.message : 'Mapping failed.')
      }

      totals.createdModules += summary.created_modules
      totals.updatedModules += summary.updated_modules
      totals.createdFunctions += summary.created_functions
      totals.updatedFunctions += summary.updated_functions
      totals.mapped += summary.mapped_count
      totals.reused += summary.reused_count ?? 0
      failed.push(...summary.failed)

      if (batches.length > 1) {
        this.log(`  Batch ${i + 1}/${batches.length} done — ${summary.mapped_count} mapped.`)
      }
    }

    this.log(
      `Done. Mapped ${totals.mapped}/${files.length} file${files.length === 1 ? '' : 's'}. ` +
        `Modules: +${totals.createdModules} new, ${totals.updatedModules} updated. ` +
        `Functions: +${totals.createdFunctions} new, ${totals.updatedFunctions} updated.`,
    )

    if (totals.reused) {
      this.log(`${totals.reused} unchanged file${totals.reused === 1 ? '' : 's'} reused from cache.`)
    }

    if (failed.length > 0) {
      this.log(`${failed.length} file${failed.length === 1 ? '' : 's'} failed to map:`)
      for (const f of failed) {
        this.log(`  ✗ ${f.file_name}: ${f.error}`)
      }
    }
  }

  /** Prompt for ephemeral OpenCode credentials used only for the one-turn selection run. */
  private async promptForEngineModel(): Promise<EngineModel> {
    this.log('OpenCode will select from the local source manifest; it will not browse the project.')
    const providerID = await input({
      message: 'OpenCode provider ID:',
      validate: (value) => value.trim() ? true : 'Provider ID is required.',
    })
    const apiKey = await password({
      mask: '*',
      message: 'Provider API key:',
      validate: (value) => value ? true : 'API key is required.',
    })
    const modelID = await input({
      message: 'Model ID:',
      validate: (value) => value.trim() ? true : 'Model ID is required.',
    })
    return {apiKey, modelID: modelID.trim(), providerID: providerID.trim()}
  }

  /**
   * Decide how OpenCode's file selection runs. Pro users go through our hosted model
   * (no setup — the CLI uses the proxy with the user's session). Free users supply their
   * own provider as before, with a nudge to upgrade. A failed tier check falls back to the
   * manual path so mapping is never blocked.
   */
  private async resolveEngineModel(ctx: MapContext): Promise<EngineModel> {
    let plan = 'free'
    try {
      plan = await getUserPlan(ctx.baseUrl, ctx.configDir)
    } catch {
      // Tier check failed — fall back to manual credentials rather than blocking the map.
    }

    if (plan === 'pro') {
      const token = await ensureAccessToken(ctx.baseUrl, ctx.configDir)
      this.log('Pro plan detected — running file selection on our hosted model (no setup needed).')
      return {
        apiKey: token,
        baseURL: `${ctx.baseUrl}/proxy/v1`,
        modelID: 'deepseek-v4-flash',
        providerID: 'vibechecker',
      }
    }

    this.log('Tip: Pro subscribers skip this step — we run file selection for you. Subscribe to enable it.')
    return this.promptForEngineModel()
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
