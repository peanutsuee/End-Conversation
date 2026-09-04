import { SESSION_META_KEY } from './constants.js';

export class SessionMetadataError extends Error {
  constructor() {
    super(`Missing required request metadata: _meta["${SESSION_META_KEY}"].`);
    this.name = 'SessionMetadataError';
  }
}

/**
 * Read the anonymous ChatGPT session ID exposed by the MCP SDK request context.
 * The value is intentionally never accepted from tool arguments.
 */
export function getSessionIdFromContext(context) {
  const metadata = context?.mcpReq?._meta;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new SessionMetadataError();
  }

  const sessionId = metadata[SESSION_META_KEY];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new SessionMetadataError();
  }

  return sessionId;
}
