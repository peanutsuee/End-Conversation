(function (root) {
  'use strict';

  const END_MESSAGE =
    "Chat ended\nChatGPT can't help with this. Start a new chat to continue.";
  const STORAGE_PREFIX = 'ended-conversation:';

  function normalizeMessageText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function isExactEndedMessage(value) {
    return normalizeMessageText(value) === END_MESSAGE;
  }

  function extractConversationId(urlValue) {
    try {
      const url = new URL(urlValue);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') {
        return null;
      }
      const match = url.pathname.match(/^\/c\/([^/]+)(?:\/|$)/);
      return match ? match[1] : null;
    } catch (_error) {
      return null;
    }
  }

  function storageKeyFor(conversationId) {
    return `${STORAGE_PREFIX}${conversationId}`;
  }

  function queryAll(document, selector) {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }

  function findLatestAssistantMessage(document) {
    const messages = queryAll(document, '[data-message-author-role="assistant"]');
    return messages.length > 0 ? messages[messages.length - 1] : null;
  }

  function messageText(message) {
    if (!message) {
      return null;
    }
    if (typeof message.innerText === 'string') {
      return message.innerText;
    }
    return typeof message.textContent === 'string' ? message.textContent : null;
  }

  function latestAssistantMessageEnded(document) {
    return isExactEndedMessage(messageText(findLatestAssistantMessage(document)));
  }

  function findComposer(document) {
    const candidates = [
      ...queryAll(document, 'textarea'),
      ...queryAll(document, '[contenteditable="true"]'),
      ...queryAll(document, '[role="textbox"]')
    ];
    const unique = [...new Set(candidates)];
    for (let index = unique.length - 1; index >= 0; index -= 1) {
      const candidate = unique[index];
      if (candidate && candidate.isConnected !== false) {
        return candidate;
      }
    }
    return null;
  }

  function composerRoot(composer, document) {
    if (!composer) {
      return null;
    }
    let rootElement = null;
    try {
      rootElement = composer.closest('form') || composer.parentElement;
    } catch (_error) {
      rootElement = composer.parentElement || null;
    }
    if (!rootElement || rootElement === document.body || rootElement === document.documentElement) {
      return null;
    }
    return rootElement;
  }

  function createController(options) {
    const environment = options || {};
    const document = environment.document || root.document;
    const window = environment.window || root.window || root;
    const chromeApi = environment.chrome || root.chrome;
    const getLocation = environment.getLocation || (() => window.location);
    const setIntervalFn = environment.setInterval || root.setInterval;
    const clearIntervalFn = environment.clearInterval || root.clearInterval;
    const MutationObserverCtor = environment.MutationObserver || root.MutationObserver;

    let started = false;
    let intervalId = null;
    let observer = null;
    let currentHref = null;
    let currentConversationId = null;
    let generation = 0;
    let storedEnded = false;
    let ended = false;
    let blockedRoot = null;
    let blockedInput = null;
    let blockerPanel = null;
    let originalInputState = null;
    let originalRootPosition = null;

    function currentUrl() {
      try {
        return getLocation()?.href || '';
      } catch (_error) {
        return '';
      }
    }

    function storageGet(key) {
      if (!chromeApi?.storage?.local?.get) {
        return Promise.resolve({});
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (!settled) {
            settled = true;
            resolve(value && typeof value === 'object' ? value : {});
          }
        };
        try {
          const result = chromeApi.storage.local.get(key, finish);
          if (result && typeof result.then === 'function') {
            result.then(finish, () => finish({}));
          }
        } catch (_error) {
          finish({});
        }
      });
    }

    function storageSet(values) {
      if (!chromeApi?.storage?.local?.set) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        try {
          const result = chromeApi.storage.local.set(values, finish);
          if (result && typeof result.then === 'function') {
            result.then(finish, finish);
          }
        } catch (_error) {
          finish();
        }
      });
    }

    function restoreBlockedInput() {
      if (blockedInput && originalInputState) {
        if ('disabled' in blockedInput) {
          blockedInput.disabled = originalInputState.disabled;
        }
        if (originalInputState.contentEditable === null) {
          blockedInput.removeAttribute('contenteditable');
        } else {
          blockedInput.setAttribute('contenteditable', originalInputState.contentEditable);
        }
        if (originalInputState.ariaDisabled === null) {
          blockedInput.removeAttribute('aria-disabled');
        } else {
          blockedInput.setAttribute('aria-disabled', originalInputState.ariaDisabled);
        }
        if (originalInputState.tabIndex === null) {
          blockedInput.removeAttribute('tabindex');
        } else {
          blockedInput.setAttribute('tabindex', originalInputState.tabIndex);
        }
        blockedInput.style.pointerEvents = originalInputState.pointerEvents;
        blockedInput.style.userSelect = originalInputState.userSelect;
      }
      if (blockedRoot && originalRootPosition !== null) {
        blockedRoot.style.position = originalRootPosition;
      }
    }

    function releaseBlocker() {
      restoreBlockedInput();
      if (blockerPanel?.remove) {
        blockerPanel.remove();
      }
      blockedRoot = null;
      blockedInput = null;
      blockerPanel = null;
      originalInputState = null;
      originalRootPosition = null;
    }

    function applyBlocker() {
      const composer = findComposer(document);
      const rootElement = composerRoot(composer, document);
      if (!rootElement) {
        return;
      }
      if (blockedRoot === rootElement && blockerPanel) {
        return;
      }
      releaseBlocker();
      blockedRoot = rootElement;
      blockedInput = composer;
      originalInputState = {
        disabled: 'disabled' in composer ? composer.disabled : false,
        contentEditable: composer.getAttribute('contenteditable'),
        ariaDisabled: composer.getAttribute('aria-disabled'),
        tabIndex: composer.getAttribute('tabindex'),
        pointerEvents: composer.style.pointerEvents || '',
        userSelect: composer.style.userSelect || ''
      };
      originalRootPosition = rootElement.style.position || '';
      if ('disabled' in composer) {
        composer.disabled = true;
      }
      if (composer.getAttribute('contenteditable') !== null) {
        composer.setAttribute('contenteditable', 'false');
      }
      composer.setAttribute('aria-disabled', 'true');
      composer.setAttribute('tabindex', '-1');
      composer.style.pointerEvents = 'none';
      composer.style.userSelect = 'none';
      rootElement.style.position = originalRootPosition || 'relative';

      blockerPanel = document.createElement('div');
      blockerPanel.setAttribute('data-end-conversation-blocker', 'true');
      blockerPanel.setAttribute('role', 'alert');
      blockerPanel.textContent = END_MESSAGE;
      blockerPanel.style.position = 'absolute';
      blockerPanel.style.inset = '0';
      blockerPanel.style.zIndex = '2147483647';
      blockerPanel.style.display = 'flex';
      blockerPanel.style.alignItems = 'center';
      blockerPanel.style.justifyContent = 'center';
      blockerPanel.style.padding = '16px';
      blockerPanel.style.boxSizing = 'border-box';
      blockerPanel.style.whiteSpace = 'pre-line';
      blockerPanel.style.textAlign = 'center';
      blockerPanel.style.background = 'var(--main-surface-primary, #ffffff)';
      blockerPanel.style.color = 'var(--text-primary, #111111)';
      blockerPanel.style.pointerEvents = 'auto';
      rootElement.appendChild(blockerPanel);
    }

    function eventIsInsideComposer(event) {
      const target = event?.target;
      if (!target) {
        return false;
      }
      const composer = findComposer(document);
      const rootElement = blockedRoot || composerRoot(composer, document);
      return Boolean(rootElement && (target === rootElement || rootElement.contains?.(target)));
    }

    function blockComposerEvent(event) {
      if (!ended || !eventIsInsideComposer(event)) {
        return;
      }
      applyBlocker();
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
    }

    function reconcile() {
      if (!currentConversationId) {
        ended = false;
        releaseBlocker();
        return;
      }
      const messageEnded = latestAssistantMessageEnded(document);
      if (messageEnded && !storedEnded) {
        storedEnded = true;
        void storageSet({ [storageKeyFor(currentConversationId)]: true });
      }
      ended = storedEnded || messageEnded;
      if (ended) {
        applyBlocker();
      } else {
        releaseBlocker();
      }
    }

    function refresh() {
      const href = currentUrl();
      const conversationId = extractConversationId(href);
      if (href !== currentHref) {
        currentHref = href;
      }
      if (conversationId !== currentConversationId) {
        currentConversationId = conversationId;
        generation += 1;
        storedEnded = false;
        ended = false;
        releaseBlocker();
        if (!conversationId) {
          return;
        }
        const expectedGeneration = generation;
        const key = storageKeyFor(conversationId);
        void storageGet(key).then((stored) => {
          if (expectedGeneration !== generation || currentConversationId !== conversationId) {
            return;
          }
          storedEnded = stored[key] === true;
          reconcile();
        });
      }
      reconcile();
    }

    function start() {
      if (started || !document) {
        return controller;
      }
      started = true;
      for (const eventName of ['beforeinput', 'click', 'compositionstart', 'drop', 'input', 'keydown', 'paste', 'submit']) {
        document.addEventListener(eventName, blockComposerEvent, true);
      }
      for (const eventName of ['hashchange', 'popstate']) {
        window.addEventListener?.(eventName, refresh);
      }
      if (MutationObserverCtor && document.documentElement) {
        observer = new MutationObserverCtor(refresh);
        observer.observe(document.documentElement, {
          childList: true,
          characterData: true,
          subtree: true
        });
      }
      if (setIntervalFn) {
        intervalId = setIntervalFn(refresh, 500);
      }
      refresh();
      return controller;
    }

    function stop() {
      if (!started) {
        return;
      }
      started = false;
      for (const eventName of ['beforeinput', 'click', 'compositionstart', 'drop', 'input', 'keydown', 'paste', 'submit']) {
        document.removeEventListener(eventName, blockComposerEvent, true);
      }
      for (const eventName of ['hashchange', 'popstate']) {
        window.removeEventListener?.(eventName, refresh);
      }
      observer?.disconnect?.();
      if (intervalId !== null && clearIntervalFn) {
        clearIntervalFn(intervalId);
      }
      intervalId = null;
      releaseBlocker();
    }

    const controller = {
      start,
      stop,
      refresh,
      getState: () => ({
        conversationId: currentConversationId,
        ended,
        blocked: Boolean(blockerPanel)
      })
    };
    return controller;
  }

  root.EndConversationCore = Object.freeze({
    END_MESSAGE,
    extractConversationId,
    findLatestAssistantMessage,
    isExactEndedMessage,
    latestAssistantMessageEnded,
    normalizeMessageText,
    storageKeyFor,
    createController
  });
})(globalThis);
