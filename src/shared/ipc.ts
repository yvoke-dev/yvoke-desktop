// Central registry of IPC channel names shared between the main process,
// the preload bridge, and (indirectly) the renderer. Keeping every channel
// string in one place avoids stringly-typed drift between sender and handler.

export const IpcChannels = {
  // invoke/handle request channels
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appVersion: 'app:version',
  promptsList: 'prompts:list',
  orchestratorProfiles: 'orchestrator:profiles',
  citationGet: 'citation:get',
  threadsList: 'threads:list',
  threadsCreate: 'threads:create',
  threadsDelete: 'threads:delete',
  threadsPatch: 'threads:patch',
  threadsMessages: 'threads:messages',
  chatSend: 'chat:send',
  chatInterrupt: 'chat:interrupt',
  chatSubmitClarification: 'chat:submit-clarification',
  feedbackSubmit: 'feedback:submit',
  authStatus: 'auth:status',
  authSignin: 'auth:signin',
  authSignout: 'auth:signout',

  // main -> renderer event channels
  agentEvent: 'agent-event',
  syncEvent: 'sync-event',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
