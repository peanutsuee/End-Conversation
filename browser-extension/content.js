(function () {
  'use strict';

  if (globalThis.EndConversationCore && globalThis.document && globalThis.chrome?.storage?.local) {
    globalThis.EndConversationCore.createController().start();
  }
})();
