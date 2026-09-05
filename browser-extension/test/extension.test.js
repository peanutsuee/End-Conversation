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

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
  }

  observe() {}

  disconnect() {}
}

function createPage({ conversationId = 'conversation-a', ended = false } = {}) {
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
  const storage = new Map();
  if (ended) {
    storage.set(`ended-conversation:${conversationId}`, true);
  }
  const window = new FakeEventTarget();
  window.location = { href: `https://chatgpt.com/c/${conversationId}` };
  const chrome = {
    storage: {
      local: {
        get: (key) => Promise.resolve({ [key]: storage.get(key) }),
        set: (values) => {
          for (const [key, value] of Object.entries(values)) {
            storage.set(key, value);
          }
          return Promise.resolve();
        }
      }
    }
  };
  const { core } = loadCore();
  const controller = core.createController({
    document,
    window,
    chrome,
    MutationObserver: FakeMutationObserver,
    setInterval: () => 1,
    clearInterval: () => {}
  });
  return { controller, document, form, composer, assistant, storage, window, core };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
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
  const endedPage = createPage({ ended: true });
  endedPage.controller.start();
  await settle();
  assert.equal(endedPage.controller.getState().conversationId, 'conversation-a');
  assert.equal(endedPage.controller.getState().ended, true);
  assert.equal(endedPage.controller.getState().blocked, true);
  assert.equal(endedPage.composer.disabled, true);
  assert.equal(endedPage.form.children.some((child) => child.getAttribute('data-end-conversation-blocker') === 'true'), true);

  const activePage = createPage({ conversationId: 'conversation-b', ended: false });
  activePage.controller.start();
  await settle();
  assert.equal(activePage.controller.getState().conversationId, 'conversation-b');
  assert.equal(activePage.controller.getState().ended, false);
  assert.equal(activePage.controller.getState().blocked, false);
  assert.equal(activePage.composer.disabled, false);
});

test('SPA navigation and refresh do not cross-contaminate conversation state', async () => {
  const page = createPage({ conversationId: 'conversation-a', ended: true });
  page.controller.start();
  await settle();
  assert.equal(page.controller.getState().blocked, true);

  page.window.location.href = 'https://chatgpt.com/c/conversation-b';
  page.assistant.innerText = 'Normal response';
  page.controller.refresh();
  await settle();
  assert.equal(page.controller.getState().conversationId, 'conversation-b');
  assert.equal(page.controller.getState().ended, false);
  assert.equal(page.controller.getState().blocked, false);

  page.window.location.href = 'https://chatgpt.com/c/conversation-a';
  page.controller.refresh();
  await settle();
  assert.equal(page.controller.getState().blocked, true);
});

test('Enter, click, submit, paste, and editing events are blocked only in ended composer', async () => {
  const endedPage = createPage({ ended: true });
  endedPage.controller.start();
  await settle();
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
  await settle();
  const event = {
    target: activePage.composer,
    prevented: false,
    preventDefault() { this.prevented = true; }
  };
  activePage.document.dispatch('keydown', event);
  assert.equal(event.prevented, false);
});
