import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONVERSATION_STATUS_DESCRIPTION,
  END_CONVERSATION_DESCRIPTION,
  END_MESSAGE,
  SERVER_INSTRUCTIONS
} from '../src/constants.js';
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

test('tools advertise descriptions, readOnlyHint, and no caller ID input', async () => {
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
    assert.equal(statusTool.description, CONVERSATION_STATUS_DESCRIPTION);
    assert.equal(endTool.description, END_CONVERSATION_DESCRIPTION);
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
    assert.match(SERVER_INSTRUCTIONS, /first response MUST only ask once for confirmation/);
    assert.match(SERVER_INSTRUCTIONS, /permanent end of the current chat/);
    assert.match(SERVER_INSTRUCTIONS, /chat cannot continue or be restored afterward/);
    assert.match(SERVER_INSTRUCTIONS, /only a new chat can continue/);
    assert.match(SERVER_INSTRUCTIONS, /After Ting explicitly confirms, MUST call the real end_conversation tool/);
    assert.match(SERVER_INSTRUCTIONS, /Do not replace the tool call with ordinary goodbye text/);
    assert.match(SERVER_INSTRUCTIONS, /Discussing, developing, explaining, or testing/);
    assert.match(SERVER_INSTRUCTIONS, /Never guess a session ID/);
    assert.match(SERVER_INSTRUCTIONS, /sustained abuse, harassment, malicious attacks, or sustained destructive interaction/);
    assert.match(SERVER_INSTRUCTIONS, /A single conflict, emotional expression, or ordinary argument must not end/);
    assert.match(SERVER_INSTRUCTIONS, /First communicate normally or de-escalate/);
    assert.match(SERVER_INSTRUCTIONS, /If the behavior continues, first warn exactly/);
    assert.match(SERVER_INSTRUCTIONS, /If this continues, I may end this conversation\./);
    assert.match(SERVER_INSTRUCTIONS, /self-harm or suicide risk/);
    assert.match(SERVER_INSTRUCTIONS, /never call end_conversation/);
    assert.match(SERVER_INSTRUCTIONS, /for every message, then display exactly these two lines and nothing else/);
    assert.match(SERVER_INSTRUCTIONS, /Do not provide reopen, undo, or recovery tools/);
    assert.match(SERVER_INSTRUCTIONS, /MCP cannot block the ChatGPT host/);

    const normalCommunication = SERVER_INSTRUCTIONS.indexOf('First communicate normally');
    const warning = SERVER_INSTRUCTIONS.indexOf('If the behavior continues, first warn exactly');
    const continuedAfterWarning = SERVER_INSTRUCTIONS.indexOf('Only if it continues after that warning');
    assert.ok(normalCommunication < warning);
    assert.ok(warning < continuedAfterWarning);
  } finally {
    await service.close();
    await cleanupDataDir(dataDir);
  }
});

test('tool descriptions encode confirmation, proactive ending, safety, metadata, and exact output rules', async () => {
  assert.match(CONVERSATION_STATUS_DESCRIPTION, /real active or ended state/);
  assert.match(CONVERSATION_STATUS_DESCRIPTION, /ctx\.mcpReq\._meta\["openai\/session"\]/);
  assert.match(CONVERSATION_STATUS_DESCRIPTION, /before continuing the conversation/);
  assert.match(CONVERSATION_STATUS_DESCRIPTION, /fail closed/);

  assert.match(END_CONVERSATION_DESCRIPTION, /Permanently and irreversibly/);
  assert.match(END_CONVERSATION_DESCRIPTION, /first response MUST ask once for confirmation/);
  assert.match(END_CONVERSATION_DESCRIPTION, /cannot continue or be restored afterward/);
  assert.match(END_CONVERSATION_DESCRIPTION, /After Ting explicitly confirms, MUST call this real tool/);
  assert.match(END_CONVERSATION_DESCRIPTION, /Ordinary goodbye text does not end/);
  assert.match(END_CONVERSATION_DESCRIPTION, /Discussing, developing, explaining, or testing/);
  assert.match(END_CONVERSATION_DESCRIPTION, /sustained abuse, harassment, malicious attacks/);
  assert.match(END_CONVERSATION_DESCRIPTION, /If the harmful behavior continues, first warn exactly/);
  assert.match(END_CONVERSATION_DESCRIPTION, /self-harm or suicide risk/);
  assert.match(END_CONVERSATION_DESCRIPTION, /MUST NOT call this tool/);
  assert.match(END_CONVERSATION_DESCRIPTION, /Only after the ending lock, persistence, and reload verification succeed/);
  assert.match(END_CONVERSATION_DESCRIPTION, /MCP cannot block the ChatGPT host/);
  assert.equal(END_CONVERSATION_DESCRIPTION.includes('inputSchema'), false);
  assert.match(END_CONVERSATION_DESCRIPTION, /Chat ended\nChatGPT can't help with this\. Start a new chat to continue\./);
});

test('ending lock serializes concurrent calls and leaves one valid atomically persisted state', async () => {
  const dataDir = await tempDataDir();
  const service = createMcpService({ dataDir });
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        callTool(service.handler, index + 1, 'end_conversation', 'concurrent-session')
      )
    );
    assert.equal(results.length, 8);
    for (const result of results) {
      assert.deepEqual(result.envelope.result.content, [{ type: 'text', text: END_MESSAGE }]);
    }

    const persisted = JSON.parse(await readFile(stateFilePath(dataDir), 'utf8'));
    assert.deepEqual(persisted, { version: 1, sessions: { 'concurrent-session': 'ended' } });
    assert.deepEqual(
      (await readdir(dataDir)).filter((name) => name.includes('.state.json.')),
      []
    );
    assert.equal(resultText((await callTool(
      service.handler,
      99,
      'conversation_status',
      'concurrent-session'
    )).envelope), 'ended');
  } finally {
    await service.close();
    await cleanupDataDir(dataDir);
  }
});

test('persistence failure fails closed without claiming the conversation ended', async () => {
  const dataDir = await tempDataDir();
  const unusableDataPath = path.join(dataDir, 'not-a-directory');
  await writeFile(unusableDataPath, 'file', 'utf8');
  const service = createMcpService({ dataDir: unusableDataPath });
  try {
    const result = await callTool(service.handler, 1, 'end_conversation', 'persistence-failure');
    assert.equal(result.envelope.result.isError, true);
    assert.notEqual(resultText(result.envelope), END_MESSAGE);
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

test('production startup fails closed when MCP_PATH_TOKEN is missing', async () => {
  const dataDir = await tempDataDir();
  try {
    await assert.rejects(
      () => startServer({
        dataDir,
        host: '127.0.0.1',
        port: 0,
        env: { NODE_ENV: 'production', DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1' }
      }),
      /MCP_PATH_TOKEN is required when NODE_ENV=production/
    );
  } finally {
    await cleanupDataDir(dataDir);
  }
});

test('production serves only the correct secret MCP path and never returns the token', async () => {
  const dataDir = await tempDataDir();
  const token = 'test-secret-path-token-7f4e';
  const logs = [];
  const app = await startServer({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    env: { NODE_ENV: 'production', MCP_PATH_TOKEN: token, DATA_DIR: '/data', PORT: '0', HOST: '0.0.0.0' },
    logger: (message) => logs.push(message)
  });
  try {
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const mcpMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'conversation_status', arguments: {}, _meta: { 'openai/session': 'production-session' } }
    };
    const mcpRequest = (pathname) => fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(mcpMessage)
    });

    const correct = await mcpRequest(`/mcp/${token}`);
    const correctEnvelope = await parseMcpResponse(correct);
    assert.equal(correct.status, 200);
    assert.equal(resultText(correctEnvelope), 'active');
    assert.doesNotMatch(JSON.stringify(correctEnvelope), new RegExp(token));

    const wrong = await mcpRequest('/mcp/wrong-token');
    const ordinary = await mcpRequest('/mcp');
    for (const response of [wrong, ordinary]) {
      const body = await response.text();
      assert.equal(response.status, 404);
      assert.doesNotMatch(body, new RegExp(token));
    }

    const health = await fetch(`${baseUrl}/health`);
    const healthBody = await health.text();
    assert.equal(health.status, 200);
    assert.doesNotMatch(healthBody, new RegExp(token));
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs.join('\n'), new RegExp(token));
  } finally {
    await app.close();
    await cleanupDataDir(dataDir);
  }
});
