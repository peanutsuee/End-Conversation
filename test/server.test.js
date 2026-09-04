import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { END_MESSAGE, SERVER_INSTRUCTIONS } from '../src/constants.js';
import { createHttpServer, createMcpService, startServer } from '../src/server.js';
import { stateFilePath } from '../src/state-store.js';

const headers = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json'
};

async function tempDataDir() {
  return mkdtemp(path.join(os.tmpdir(), 'chatgpt-end-conversation-'));
}

async function cleanupDataDir(dataDir) {
  await rm(dataDir, { recursive: true, force: true });
}

async function parseMcpResponse(response) {
  const body = await response.text();
  const dataLine = body.split(/\r?\n/).find((line) => line.startsWith('data: '));
  assert.ok(dataLine, `MCP response did not contain an SSE data line: ${body}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

async function mcpRequest(handler, message) {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(message)
    })
  );
  return { response, envelope: await parseMcpResponse(response) };
}

async function initialize(handler) {
  return mcpRequest(handler, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' }
    }
  });
}

async function callTool(handler, id, name, sessionId, arguments_ = {}) {
  return mcpRequest(handler, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: arguments_,
      ...(sessionId === undefined ? {} : { _meta: { 'openai/session': sessionId } })
    }
  });
}

function resultText(envelope) {
  return envelope.result?.content?.find((item) => item.type === 'text')?.text;
}

test('conversation_status reads SDK-exposed metadata and starts active', async () => {
  const dataDir = await tempDataDir();
  const service = createMcpService({ dataDir });
  try {
    const result = await callTool(
      service.handler,
      2,
      'conversation_status',
      'session-a',
      { conversationId: 'must-be-ignored' }
    );
    assert.equal(result.response.status, 200);
    assert.equal(resultText(result.envelope), 'active');
    assert.equal(result.envelope.result.isError, undefined);
  } finally {
    await service.close();
    await cleanupDataDir(dataDir);
  }
});

test('end_conversation is permanent, idempotent, and returns exact text', async () => {
  const dataDir = await tempDataDir();
  const service = createMcpService({ dataDir });
  try {
    const first = await callTool(service.handler, 1, 'end_conversation', 'session-a');
    const second = await callTool(service.handler, 2, 'end_conversation', 'session-a');
    const status = await callTool(service.handler, 3, 'conversation_status', 'session-a');

    assert.deepEqual(first.envelope.result.content, [{ type: 'text', text: END_MESSAGE }]);
    assert.deepEqual(second.envelope.result.content, [{ type: 'text', text: END_MESSAGE }]);
    assert.equal(resultText(status.envelope), 'ended');
    assert.equal(END_MESSAGE, 'Chat ended\nChatGPT can\'t help with this. Start a new chat to continue.');
  } finally {
    await service.close();
    await cleanupDataDir(dataDir);
  }
});

test('ended state survives a service restart', async () => {
  const dataDir = await tempDataDir();
  const firstService = createMcpService({ dataDir });
  try {
    await callTool(firstService.handler, 1, 'end_conversation', 'session-restart');
  } finally {
    await firstService.close();
  }

  const secondService = createMcpService({ dataDir });
  try {
    const result = await callTool(secondService.handler, 2, 'conversation_status', 'session-restart');
    assert.equal(resultText(result.envelope), 'ended');
  } finally {
    await secondService.close();
    await cleanupDataDir(dataDir);
  }
});

test('different session IDs remain isolated', async () => {
  const dataDir = await tempDataDir();
  const service = createMcpService({ dataDir });
  try {
    await callTool(service.handler, 1, 'end_conversation', 'session-a');
    const ended = await callTool(service.handler, 2, 'conversation_status', 'session-a');
    const active = await callTool(service.handler, 3, 'conversation_status', 'session-b');
    assert.equal(resultText(ended.envelope), 'ended');
    assert.equal(resultText(active.envelope), 'active');
  } finally {
    await service.close();
    await cleanupDataDir(dataDir);
  }
});

test('missing session metadata is rejected without guessing an ID', async () => {
  const dataDir = await tempDataDir();
  const service = createMcpService({ dataDir });
  try {
    const status = await callTool(service.handler, 1, 'conversation_status', undefined);
    const end = await callTool(service.handler, 2, 'end_conversation', undefined);
    assert.equal(status.envelope.result.isError, true);
    assert.equal(end.envelope.result.isError, true);
    assert.match(resultText(status.envelope), /_meta\["openai\/session"\]/);
    assert.match(resultText(end.envelope), /_meta\["openai\/session"\]/);
  } finally {
    await service.close();
    await cleanupDataDir(dataDir);
  }
});

test('malformed state fails closed and is not overwritten', async () => {
  const dataDir = await tempDataDir();
  await writeFile(stateFilePath(dataDir), '{ definitely not JSON', 'utf8');
  const service = createMcpService({ dataDir });
  try {
    const status = await callTool(service.handler, 1, 'conversation_status', 'session-a');
    const end = await callTool(service.handler, 2, 'end_conversation', 'session-a');
    assert.equal(status.envelope.result.isError, true);
    assert.equal(end.envelope.result.isError, true);
    assert.equal(await readFile(stateFilePath(dataDir), 'utf8'), '{ definitely not JSON');
  } finally {
    await service.close();
    await cleanupDataDir(dataDir);
  }
});

test('conversation_status advertises readOnlyHint and no caller ID input', async () => {
  const dataDir = await tempDataDir();
  const service = createMcpService({ dataDir });
  try {
    const tools = await mcpRequest(service.handler, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    });
    const statusTool = tools.envelope.result.tools.find((tool) => tool.name === 'conversation_status');
    const endTool = tools.envelope.result.tools.find((tool) => tool.name === 'end_conversation');
    assert.equal(statusTool.annotations.readOnlyHint, true);
    assert.deepEqual(statusTool.inputSchema.properties, {});
    assert.equal(statusTool.inputSchema.required, undefined);
    assert.deepEqual(endTool.inputSchema.properties, {});
    assert.equal(endTool.inputSchema.required, undefined);
  } finally {
    await service.close();
    await cleanupDataDir(dataDir);
  }
});

test('server instructions include the confirmation, discussion, and ended blocking rules', async () => {
  const dataDir = await tempDataDir();
  const service = createMcpService({ dataDir });
  try {
    const initialized = await initialize(service.handler);
    assert.equal(initialized.envelope.result.instructions, SERVER_INSTRUCTIONS);
    assert.match(SERVER_INSTRUCTIONS, /ask once whether Ting is sure/);
    assert.match(SERVER_INSTRUCTIONS, /do not call end_conversation yet/);
    assert.match(SERVER_INSTRUCTIONS, /for every later message display exactly/);
    assert.match(SERVER_INSTRUCTIONS, /Discussing, developing, or testing/);
    assert.match(SERVER_INSTRUCTIONS, /Do not provide reopen, undo, or recovery tools/);
  } finally {
    await service.close();
    await cleanupDataDir(dataDir);
  }
});

test('HTTP server exposes health and Streamable HTTP at /mcp', async () => {
  const dataDir = await tempDataDir();
  const app = await startServer({ dataDir, host: '127.0.0.1', port: 0 });
  try {
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const call = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'conversation_status', arguments: {}, _meta: { 'openai/session': 'http-session' } }
      })
    });
    const envelope = await parseMcpResponse(call);
    assert.equal(call.status, 200);
    assert.equal(resultText(envelope), 'active');
  } finally {
    await app.close();
    await cleanupDataDir(dataDir);
  }
});
