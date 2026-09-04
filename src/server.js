import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  APP_NAME,
  APP_VERSION,
  END_MESSAGE,
  SERVER_INSTRUCTIONS
} from './constants.js';
import { getSessionIdFromContext, SessionMetadataError } from './session-metadata.js';
import { resolveDataDir, StateStore, StateStoreError } from './state-store.js';

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(error) {
  if (error instanceof SessionMetadataError) {
    return { isError: true, ...textResult(error.message) };
  }
  if (error instanceof StateStoreError) {
    return { isError: true, ...textResult('Conversation state is unavailable.') };
  }
  return { isError: true, ...textResult('Conversation operation failed.') };
}

async function callWithSession(context, operation) {
  try {
    const sessionId = getSessionIdFromContext(context);
    return textResult(await operation(sessionId));
  } catch (error) {
    return errorResult(error);
  }
}

function buildMcpServer(store) {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    'conversation_status',
    {
      title: 'Conversation status',
      description: 'Return active or ended for the current ChatGPT conversation.',
      annotations: { readOnlyHint: true }
    },
    (context) => callWithSession(context, (sessionId) => store.getStatus(sessionId))
  );

  server.registerTool(
    'end_conversation',
    {
      title: 'End conversation',
      description: 'Permanently mark the current ChatGPT conversation as ended.',
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    (context) => callWithSession(context, (sessionId) => store.endSession(sessionId).then(() => END_MESSAGE))
  );

  return server;
}

export function createMcpService(options = {}) {
  const dataDir = path.resolve(options.dataDir || resolveDataDir());
  const store = new StateStore(dataDir);
  const handler = createMcpHandler(() => buildMcpServer(store), {
    legacy: 'stateless'
  });

  return {
    dataDir,
    handler,
    store,
    close: () => handler.close()
  };
}

export function createHttpServer(options = {}) {
  const service = createMcpService(options);
  const mcpNodeHandler = toNodeHandler(service.handler);

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://localhost');

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (requestUrl.pathname === '/mcp') {
      void mcpNodeHandler(request, response);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });

  return {
    server,
    service,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await service.close();
    }
  };
}

export async function startServer(options = {}) {
  const app = createHttpServer(options);
  const port = options.port ?? Number.parseInt(process.env.PORT || '3000', 10);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, resolve);
  });
  return { ...app, address: app.server.address() };
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const app = await startServer();
  const address = app.address;
  const printableAddress = typeof address === 'object' && address
    ? `${address.address}:${address.port}`
    : String(address);
  console.log(`ChatGPT End Conversation MCP listening on ${printableAddress}`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
