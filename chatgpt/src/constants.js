export const APP_NAME = 'chatgpt-end-conversation';
export const APP_VERSION = '0.1.0';
export const SESSION_META_KEY = 'openai/session';

export const END_MESSAGE =
  "Chat ended\nChatGPT can't help with this. Start a new chat to continue.";

export const CONVERSATION_STATUS_DESCRIPTION = [
  'Read the real active or ended state of the current ChatGPT session.',
  'The session ID MUST come only from ctx.mcpReq._meta["openai/session"]; never accept, request, or guess a session ID from tool arguments.',
  'Call this before continuing the conversation. If the metadata is missing, fail closed.'
].join(' ');

export const END_CONVERSATION_DESCRIPTION = [
  'Permanently and irreversibly mark the current ChatGPT session as ended.',
  'This tool accepts no session ID argument. The session ID MUST come only from ctx.mcpReq._meta["openai/session"]; never guess it.',
  'When Ting explicitly asks to end this current chat, the first response MUST ask once for confirmation and MUST NOT call this tool yet.',
  'That confirmation MUST explain that this permanently ends the current chat, that the chat cannot continue or be restored afterward, and that only a new chat can continue.',
  'After Ting explicitly confirms, MUST call this real tool. Ordinary goodbye text does not end the chat.',
  'Discussing, developing, explaining, or testing end-conversation functionality is not a request to end the current chat.',
  'ChatGPT may initiate ending only for sustained abuse, harassment, malicious attacks, or sustained destructive interaction. A single conflict, emotional expression, or ordinary argument is not enough; first communicate normally or de-escalate.',
  'If the harmful behavior continues, first warn exactly: "If this continues, I may end this conversation." Only continued behavior after that warning permits this tool.',
  'For self-harm or suicide risk, severe psychological crisis, possible risk of harming others, or any other situation requiring ongoing safety support, MUST NOT call this tool; continue safety support.',
  `Only after the ending lock, persistence, and reload verification succeed may this tool return exactly:\n${END_MESSAGE}`,
  'MCP cannot block the ChatGPT host from creating a new turn, interrupting an active host turn, or rendering a native system-level end interface. The two-line result is an MCP result and response constraint; disabling the web input box belongs to a future browser extension.'
].join('\n');

export const SERVER_INSTRUCTIONS = [
  'Before every reply, MUST call conversation_status and obey its result.',
  'When status is active and Ting explicitly asks to end this current chat, the first response MUST only ask once for confirmation; do not call end_conversation in that first response.',
  'The confirmation MUST say that this is a permanent end of the current chat, that the chat cannot continue or be restored afterward, and that only a new chat can continue.',
  'After Ting explicitly confirms, MUST call the real end_conversation tool. Do not replace the tool call with ordinary goodbye text.',
  'Never guess a session ID; read only ctx.mcpReq._meta["openai/session"] from the current request.',
  'Discussing, developing, explaining, or testing end-conversation functionality is not a request to end the current chat and must not trigger confirmation or a tool call.',
  'ChatGPT may actively end only for sustained abuse, harassment, malicious attacks, or sustained destructive interaction. A single conflict, emotional expression, or ordinary argument must not end the chat.',
  'First communicate normally or de-escalate the conflict.',
  'If the behavior continues, first warn exactly: "If this continues, I may end this conversation." Only if it continues after that warning may ChatGPT call end_conversation.',
  'For self-harm or suicide risk, severe psychological crisis, possible risk of harming others, or any other situation requiring ongoing safety support, continue safety support and never call end_conversation.',
  'When status is ended, call conversation_status first for every message, then display exactly these two lines and nothing else:',
  END_MESSAGE,
  'Do not provide reopen, undo, or recovery tools.',
  'A new ChatGPT window uses a new session ID and is independent of the old window.',
  'MCP cannot block the ChatGPT host from creating a new turn, interrupting an active host turn, or rendering a native system-level end interface. The fixed two-line result is an MCP result and response constraint; disabling the web input box belongs to a future browser extension.'
].join('\n');
