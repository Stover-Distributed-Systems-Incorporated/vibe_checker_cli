/* eslint-disable camelcase -- request/response fields mirror the API's snake_case JSON contract */
/* eslint-disable n/no-unsupported-features/node-builtins -- fetch/Response are available in our Node 18+ runtime */
export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token: string
  token_type: string
}

/**
 * POST JSON to the API as a CLI client. The X-Client-Type header tells the API
 * to return tokens in the response body instead of HTTP-only cookies. Throws an
 * Error carrying the API's `detail` message on a non-2xx response.
 */
async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Type': 'cli',
      },
      method: 'POST',
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not reach the API at ${baseUrl}: ${reason}`)
  }

  const data = (await response.json().catch(() => null)) as null | Record<string, unknown>

  if (!response.ok) {
    const detail = (data?.detail as string) ?? `Request failed with status ${response.status}`
    throw new Error(detail)
  }

  return data as T
}

/** Authenticate with a username/email + password and receive a token pair. */
export async function signin(baseUrl: string, identifier: string, password: string): Promise<TokenResponse> {
  return postJson<TokenResponse>(baseUrl, '/authenticate-signin', {
    password,
    user_identifier: identifier,
  })
}

/** Exchange a refresh token for a fresh token pair (the old one is rotated out). */
export async function refresh(baseUrl: string, refreshToken: string): Promise<TokenResponse> {
  return postJson<TokenResponse>(baseUrl, '/refresh', {refresh_token: refreshToken})
}
