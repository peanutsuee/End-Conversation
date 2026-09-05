const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const coreSource = fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8');

function loadCore() {
  const context = { console, URL, Set, Map, Promise, Object, Array, String, Boolean };
  context.globalThis = context;
  vm.runInNewContext(coreSource, context, { filename: 'core.js' });
  return { core: context.EndConversationCore, context };
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.attributes = new Map();
    this.style = {};
    this.disabled = false;
    this.textContent = '';
    this.innerText = '';
  }

  appendChild(child) {
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
    this.parentElement = null;
    this.isConnected = false;
  }

  contains(node) {
    if (node === this) {
      return true;
    }
    return this.children.some((child) => child.contains(node));
  }

  closest(selector) {
    if (selector === 'form') {
      let node = this;
      while (node) {
        if (node.tagName === 'FORM') {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.body = new FakeElement('body');
    this.documentElement = new FakeElement('html');
    this.documentElement.appendChild(this.body);
    this.assistantMessages = [];
    this.composers = [];
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  querySelectorAll(selector) {
    if (selector === '[data-message-author-role="assistant"]') {
      return this.assistantMessages;
    }
    if (selector === 'textarea') {
      return this.composers.filter((element) => element.tagName === 'TEXTAREA');
    }
    if (selector === '[contenteditable="true"]') {
      return this.composers.filter((element) => element.getAttribute('contenteditable') === 'true');
    }
    if (selector === '[role="textbox"]') {
      return this.composers.filter((element) => element.getAttribute('role') === 'textbox');
    }
    return [];
  }
}

function createPage({
  conversationId = 'conversation-a',
  ended = false,
  storedEnded = ended,
  schemaVersion = 1,
  storage: suppliedStorage
} = {}) {
  const document = new FakeDocument();
  const form = new FakeElement('form');
  const composer = new FakeElement('textarea');
  form.appendChild(composer);
  document.body.appendChild(form);
  document.composers = [composer];
  const assistant = new FakeElement('div');
  assistant.setAttribute('data-message-author-role', 'assistant');
  assistant.innerText = ended
    ? "Chat ended\nChatGPT can't help with this. Start a new chat to continue."
    : 'Normal response';
  document.assistantMessages = [assistant];
  const storage = suppliedStorage || new Map();
  const { core } = loadCore();
  if (schemaVersion !== undefined) {
    storage.set(core.STORAGE_SCHEMA_KEY, schemaVersion);
  }
  if (storedEnded) {
    storage.set(`ended-conversation:${conversationId}`, true);
  }
  const window = new FakeEventTarget();
  window.location = { href: `https://chatgpt.com/c/${conversationId}` };
  const chrome = {
    storage: {
      local: {
        get: (key) => {
          if (key === null) {
            return Promise.resolve(Object.fromEntries(storage.entries()));
          }
          return Promise.resolve({ [key]: storage.get(key) });
        },
        set: (values) => {
          for (const [key, value] of Object.entries(values)) {
            storage.set(key, value);
          }
          return Promise.resolve();
        },
        remove: (keys) => {
          for (const key of keys) {
            storage.delete(key);
          }
          return Promise.resolve();
        }
      }
    }
  };
  let mutationObserverCallback = null;
  class TestMutationObserver {
    constructor(callback) {
      mutationObserverCallback = callback;
    }

    observe() {}

    disconnect() {}
  }
  const controller = core.createController({
    document,
    window,
    chrome,
    MutationObserver: TestMutationObserver,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout
  });
  return {
    controller,
    document,
    form,
    composer,
    assistant,
    storage,
    window,
    core,
    triggerMutation: () => mutationObserverCallback?.()
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForStableDom(page) {
  await new Promise((resolve) => setTimeout(resolve, page.core.DOM_STABILITY_MS + 40));
  await settle();
}

test('extracts only stable ChatGPT conversation IDs', () => {
  const { core } = loadCore();
  assert.equal(core.extractConversationId('https://chatgpt.com/c/abc-123'), 'abc-123');
  assert.equal(core.extractConversationId('https://chatgpt.com/c/abc-123/'), 'abc-123');
  assert.equal(core.extractConversationId('https://chatgpt.com/'), null);
  assert.equal(core.extractConversationId('https://chatgpt.com/share/abc-123'), null);
  assert.equal(core.extractConversationId('http://chatgpt.com/c/abc-123'), null);
  assert.equal(core.extractConversationId('https://example.com/c/abc-123'), null);
});

test('manifest keeps permissions and host matching minimal', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'End Conversation for ChatGPT');
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://chatgpt.com/*']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('matches only the exact two-line ended message after safe whitespace normalization', () => {
  const { core } = loadCore();
  assert.equal(core.isExactEndedMessage("  Chat ended\r\n\r\nChatGPT can't help with this. Start a new chat to continue.  "), true);
  assert.equal(core.isExactEndedMessage("Chat ended\nChatGPT can't help with this. Start a new chat to continue.\nExtra"), false);
  assert.equal(core.isExactEndedMessage('A discussion quoting Chat ended'), false);
  assert.equal(core.isExactEndedMessage("Chat ended\nChatGPT can't help with this. Start a new chat to continue. quoted"), false);
});

test('only the latest assistant message can trigger ended', () => {
  const { core } = loadCore();
  const document = new FakeDocument();
  const oldMessage = new FakeElement('div');
  oldMessage.setAttribute('data-message-author-role', 'assistant');
  oldMessage.innerText = "Chat ended\nChatGPT can't help with this. Start a new chat to continue.";
  const latestMessage = new FakeElement('div');
  latestMessage.setAttribute('data-message-author-role', 'assistant');
  latestMessage.innerText = 'Normal discussion';
  document.assistantMessages = [oldMessage, latestMessage];
  assert.equal(core.latestAssistantMessageEnded(document), false);
});

test('ended conversation persists and active conversation remains unblocked', async () => {
  const endedPage = createPage({ ended: true, storedEnded: false });
  endedPage.controller.start();
  await waitForStableDom(endedPage);
  assert.equal(endedPage.controller.getState().conversationId, 'conversation-a');
  assert.equal(endedPage.controller.getState().ended, true);
  assert.equal(endedPage.controller.getState().blocked, true);
  assert.equal(endedPage.composer.disabled, true);
  assert.equal(endedPage.form.children.some((child) => child.getAttribute('data-end-conversation-blocker') === 'true'), true);

  const activePage = createPage({ conversationId: 'conversation-b', ended: false });
  activePage.controller.start();
  await waitForStableDom(activePage);
  assert.equal(activePage.controller.getState().conversationId, 'conversation-b');
  assert.equal(activePage.controller.getState().ended, false);
  assert.equal(activePage.controller.getState().blocked, false);
  assert.equal(activePage.composer.disabled, false);
});

test('SPA navigation and refresh do not cross-contaminate conversation state', async () => {
  const page = createPage({ conversationId: 'conversation-a', ended: true, storedEnded: false });
  page.controller.start();
  await waitForStableDom(page);
  assert.equal(page.controller.getState().blocked, true);

  page.window.location.href = 'https://chatgpt.com/c/conversation-b';
  page.controller.refresh();
  await settle();
  assert.equal(page.controller.getState().conversationId, 'conversation-b');
  assert.equal(page.controller.getState().ended, false);
  assert.equal(page.controller.getState().blocked, false);

  await waitForStableDom(page);
  assert.equal(page.storage.get('ended-conversation:conversation-b'), undefined);

  page.assistant.isConnected = false;
  const activeB = new FakeElement('div');
  activeB.setAttribute('data-message-author-role', 'assistant');
  activeB.innerText = 'Normal response';
  page.document.assistantMessages = [activeB];
  page.triggerMutation();
  await waitForStableDom(page);
  assert.equal(page.controller.getState().ended, false);
  assert.equal(page.controller.getState().blocked, false);
  assert.equal(page.storage.get('ended-conversation:conversation-b'), undefined);

  const reloadedB = createPage({
    conversationId: 'conversation-b',
    ended: false,
    storage: page.storage
  });
  reloadedB.controller.start();
  await waitForStableDom(reloadedB);
  assert.equal(reloadedB.controller.getState().ended, false);
  assert.equal(reloadedB.controller.getState().blocked, false);
  reloadedB.controller.stop();

  page.window.location.href = 'https://chatgpt.com/c/conversation-a';
  activeB.isConnected = false;
  const endedA = new FakeElement('div');
  endedA.setAttribute('data-message-author-role', 'assistant');
  endedA.innerText = "Chat ended\nChatGPT can't help with this. Start a new chat to continue.";
  page.document.assistantMessages = [endedA];
  page.controller.refresh();
  await settle();
  assert.equal(page.controller.getState().blocked, true);
});

test('one-time migration clears v0.1.0 ended IDs and preserves the active chat', async () => {
  const page = createPage({
    conversationId: 'conversation-b',
    ended: false,
    storedEnded: true,
    schemaVersion: 0
  });
  page.controller.start();
  await waitForStableDom(page);
  assert.equal(page.storage.get('ended-conversation:conversation-b'), undefined);
  assert.equal(page.storage.get(page.core.STORAGE_SCHEMA_KEY), page.core.STORAGE_SCHEMA_VERSION);
  assert.equal(page.controller.getState().ended, false);
  assert.equal(page.controller.getState().blocked, false);
});

test('active conversations can switch repeatedly without sharing ended state', async () => {
  const page = createPage({ conversationId: 'conversation-a', ended: false });
  page.controller.start();
  await waitForStableDom(page);

  for (const conversationId of ['conversation-b', 'conversation-c']) {
    page.window.location.href = `https://chatgpt.com/c/${conversationId}`;
    page.controller.refresh();
    assert.equal(page.controller.getState().blocked, false);
    assert.equal(page.storage.get(`ended-conversation:${conversationId}`), undefined);

    const oldAssistant = page.document.assistantMessages[0];
    oldAssistant.isConnected = false;
    const nextAssistant = new FakeElement('div');
    nextAssistant.setAttribute('data-message-author-role', 'assistant');
    nextAssistant.innerText = 'Normal response';
    page.document.assistantMessages = [nextAssistant];
    page.triggerMutation();
    await waitForStableDom(page);
    assert.equal(page.controller.getState().ended, false);
    assert.equal(page.controller.getState().blocked, false);
    assert.equal(page.storage.get(`ended-conversation:${conversationId}`), undefined);
  }
});

test('Enter, click, submit, paste, and editing events are blocked only in ended composer', async () => {
  const endedPage = createPage({ ended: true });
  endedPage.controller.start();
  await waitForStableDom(endedPage);
  for (const type of ['keydown', 'click', 'submit', 'paste', 'beforeinput', 'input', 'drop']) {
    const event = {
      target: endedPage.composer,
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      stopPropagation() { this.stopped = true; }
    };
    endedPage.document.dispatch(type, event);
    assert.equal(event.prevented, true, type);
    assert.equal(event.stopped, true, type);
  }

  const activePage = createPage({ ended: false });
  activePage.controller.start();
  await waitForStableDom(activePage);
  const event = {
    target: activePage.composer,
    prevented: false,
    preventDefault() { this.prevented = true; }
  };
  activePage.document.dispatch('keydown', event);
  assert.equal(event.prevented, false);
});
