export const APP_NAME = 'chatgpt-end-conversation';
export const APP_VERSION = '0.1.0';
export const SESSION_META_KEY = 'openai/session';

export const END_MESSAGE =
  "Chat ended\nChatGPT can't help with this. Start a new chat to continue.";

export const SERVER_INSTRUCTIONS = [
  'Before every reply, first call conversation_status.',
  'When the status is active, enter the ending flow only when Ting explicitly asks to end this current conversation.',
  'On the first explicit request to end the current conversation, ask once whether Ting is sure; do not call end_conversation yet.',
  'After Ting explicitly confirms, call end_conversation.',
  'Discussing, developing, or testing the end-conversation feature is not a request to end the current window.',
  'When the status is ended, for every later message display exactly these two lines and nothing else:',
  END_MESSAGE,
  'Do not provide reopen, undo, or recovery tools.',
  'A new ChatGPT window uses a new session ID and is independent of the old window.'
].join('\n');
