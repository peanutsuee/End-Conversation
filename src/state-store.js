import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_VERSION = 1;
const STATE_FILE_NAME = 'state.json';
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../runtime/', import.meta.url));

export class StateStoreError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'StateStoreError';
  }
}

export function resolveDataDir({ env = process.env, cwd = process.cwd() } = {}) {
  return path.resolve(cwd, env.DATA_DIR || DEFAULT_DATA_DIR);
}

export function stateFilePath(dataDir) {
  return path.join(path.resolve(dataDir), STATE_FILE_NAME);
}

function emptyState() {
  return { version: STATE_VERSION, sessions: Object.create(null) };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseState(serialized) {
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new StateStoreError('Conversation state is malformed.', { cause: error });
  }

  if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !isRecord(parsed.sessions)) {
    throw new StateStoreError('Conversation state is malformed.');
  }

  const sessions = Object.create(null);
  for (const [sessionId, status] of Object.entries(parsed.sessions)) {
    if (sessionId.length === 0 || status !== 'ended') {
      throw new StateStoreError('Conversation state is malformed.');
    }
    sessions[sessionId] = status;
  }

  return { version: STATE_VERSION, sessions };
}

export class StateStore {
  #writeTail = Promise.resolve();

  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.filePath = stateFilePath(this.dataDir);
  }

  async getStatus(sessionId) {
    const state = await this.#read();
    return state.sessions[sessionId] === 'ended' ? 'ended' : 'active';
  }

  async endSession(sessionId) {
    return this.#withWriteLock(async () => {
      const state = await this.#read();
      if (state.sessions[sessionId] !== 'ended') {
        state.sessions[sessionId] = 'ended';
        await this.#writeAtomically(state);
      }
      return 'ended';
    });
  }

  async #read() {
    try {
      const serialized = await readFile(this.filePath, 'utf8');
      return parseState(serialized);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return emptyState();
      }
      if (error instanceof StateStoreError) {
        throw error;
      }
      throw new StateStoreError('Conversation state is unavailable.', { cause: error });
    }
  }

  async #writeAtomically(state) {
    await mkdir(this.dataDir, { recursive: true });
    const temporaryPath = path.join(
      this.dataDir,
      `.${STATE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`
    );
    const serialized = `${JSON.stringify(state, null, 2)}\n`;

    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw new StateStoreError('Conversation state could not be saved.', { cause: error });
    }
  }

  #withWriteLock(task) {
    const operation = this.#writeTail.then(task, task);
    this.#writeTail = operation.catch(() => {});
    return operation;
  }
}
