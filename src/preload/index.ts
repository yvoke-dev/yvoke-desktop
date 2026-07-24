import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipc';
import type {
  AgentEvent,
  AppSettings,
  AuthStatus,
  ChatMessage,
  CitationRef,
  FeedbackRequest,
  McpPromptInfo,
  OrchestratorProfile,
  SendMessageRequest,
  SyncEvent,
  ThreadMeta,
} from '../shared/types';

export interface DesktopApi {
  getAppVersion(): Promise<string>;
  getSettings(): Promise<AppSettings>;
  setSettings(update: Partial<AppSettings>): Promise<AppSettings>;
  listThreads(): Promise<{ threads: ThreadMeta[]; serverReachable: boolean }>;
  createThread(): Promise<ThreadMeta>;
  deleteThread(threadId: string): Promise<void>;
  patchThread(threadId: string, update: Partial<ThreadMeta>): Promise<ThreadMeta | undefined>;
  getMessages(threadId: string): Promise<ChatMessage[]>;
  listPrompts(): Promise<McpPromptInfo[]>;
  listOrchestratorProfiles(): Promise<OrchestratorProfile[]>;
  getCitation(ref: CitationRef): Promise<string>;
  sendMessage(request: SendMessageRequest): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  submitClarification(threadId: string, toolUseId: string, answer: string): Promise<void>;
  submitFeedback(request: FeedbackRequest): Promise<void>;
  authStatus(): Promise<AuthStatus>;
  serverSignIn(): Promise<string | undefined>;
  serverSignOut(): Promise<void>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onSyncEvent(listener: (event: SyncEvent) => void): () => void;
}

const api: DesktopApi = {
  getAppVersion: () => ipcRenderer.invoke(IpcChannels.appVersion),
  getSettings: () => ipcRenderer.invoke(IpcChannels.settingsGet),
  setSettings: (update) => ipcRenderer.invoke(IpcChannels.settingsSet, update),
  listThreads: () => ipcRenderer.invoke(IpcChannels.threadsList),
  createThread: () => ipcRenderer.invoke(IpcChannels.threadsCreate),
  deleteThread: (threadId) => ipcRenderer.invoke(IpcChannels.threadsDelete, threadId),
  patchThread: (threadId, update) => ipcRenderer.invoke(IpcChannels.threadsPatch, threadId, update),
  getMessages: (threadId) => ipcRenderer.invoke(IpcChannels.threadsMessages, threadId),
  listPrompts: () => ipcRenderer.invoke(IpcChannels.promptsList),
  listOrchestratorProfiles: () => ipcRenderer.invoke(IpcChannels.orchestratorProfiles),
  getCitation: (ref) => ipcRenderer.invoke(IpcChannels.citationGet, ref),
  sendMessage: (request) => ipcRenderer.invoke(IpcChannels.chatSend, request),
  interrupt: (threadId) => ipcRenderer.invoke(IpcChannels.chatInterrupt, threadId),
  submitClarification: (threadId, toolUseId, answer) =>
    ipcRenderer.invoke(IpcChannels.chatSubmitClarification, threadId, toolUseId, answer),
  submitFeedback: (request) => ipcRenderer.invoke(IpcChannels.feedbackSubmit, request),
  authStatus: () => ipcRenderer.invoke(IpcChannels.authStatus),
  serverSignIn: () => ipcRenderer.invoke(IpcChannels.authSignin),
  serverSignOut: () => ipcRenderer.invoke(IpcChannels.authSignout),
  onAgentEvent: (listener) => {
    const handler = (_event: unknown, payload: AgentEvent) => listener(payload);
    ipcRenderer.on(IpcChannels.agentEvent, handler);
    return () => ipcRenderer.removeListener(IpcChannels.agentEvent, handler);
  },
  onSyncEvent: (listener) => {
    const handler = (_event: unknown, payload: SyncEvent) => listener(payload);
    ipcRenderer.on(IpcChannels.syncEvent, handler);
    return () => ipcRenderer.removeListener(IpcChannels.syncEvent, handler);
  },
};

contextBridge.exposeInMainWorld('api', api);
