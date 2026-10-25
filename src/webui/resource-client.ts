/** Dashboard resource requests share the existing cookie and page CSRF bootstrap. */
import type { ManagementWriteClientOptions } from './write-client.js'
export type ResourceOperation =
  | 'tokens_list'
  | 'tokens_create'
  | 'tokens_delete'
  | 'tokens_rotate'
  | 'pairing_codes_list'
  | 'pairing_codes_create'
  | 'pairing_codes_revoke'
  | 'pairings_list'
  | 'pairings_delete'
  | 'devices_delete'
export type ResourceTransport = (
  operation: ResourceOperation,
  args: Record<string, unknown>,
  signal: AbortSignal
) => Promise<unknown>
export class ResourceError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export function createResourceClient(csrf: ManagementWriteClientOptions['csrf']): ResourceTransport {
  return async (operation, args, signal) => {
    const proof = await csrf(signal)
    if (!proof) {
      throw new ResourceError('unauthenticated')
    }
    const response = await fetch('/admin/v1/resources/' + operation, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json', 'x-rovloom-csrf': proof },
      body: JSON.stringify(args)
    })
    if (!response.ok) {
      throw new ResourceError(
        response.status === 401
          ? 'unauthenticated'
          : response.status === 403
            ? 'forbidden'
            : response.status === 400
              ? 'invalid_arguments'
              : 'backend_unavailable'
      )
    }
    return response.json()
  }
}
