const DEFAULT_BASE_URL = 'https://api.vibe-checker.ai'

/**
 * Resolve the Vibe Checker API base URL. Defaults to production; set
 * VIBECHECKER_BASEURL (e.g. http://localhost:8000) to point at a local API
 * during development.
 */
export function getBaseUrl(): string {
  const override = process.env.VIBECHECKER_BASEURL?.trim()
  return override || DEFAULT_BASE_URL
}
