import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { IpcChannels } from '../shared/ipc';
import type { FeedbackRequest, SendMessageRequest, ThreadMeta } from '../shared/types';
import { AppCore } from './AppCore';
import { fileTokenCache } from './auth/ServerAuth';
import { log, packageVersion } from './log';

let core: AppCore | null = null;
let mainWindow: BrowserWindow | null = null;

// The origin the renderer is loaded from. Any navigation or IPC that does not
// match this origin is treated as untrusted.
function appOrigin(): string {
  const appUrl =
    process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString();
  try {
    return new URL(appUrl).origin;
  } catch {
    return '';
  }
}

// Only ever hand https (and mailto) links to the OS. Anything else — file:,
// smb:, javascript:, ms-*, custom schemes — is silently denied so a compromised
// renderer cannot use shell.openExternal as a launch primitive.
function openExternalSafe(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve();
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
    return shell.openExternal(url);
  }
  return Promise.resolve();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Yvoke - Desktop',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const origin = appOrigin();

  // External links open in the system browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // Pin the top frame to the app origin. A renderer XSS must not be able to
  // navigate (or be redirected) to a remote origin that would re-receive the
  // preload bridge; such targets are opened externally instead.
  const guardNavigation = (event: { preventDefault(): void }, target: string): void => {
    let targetOrigin: string;
    try {
      targetOrigin = new URL(target).origin;
    } catch {
      return;
    }
    if (targetOrigin !== origin) {
      event.preventDefault();
      openExternalSafe(target);
    }
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Wrap ipcMain.handle so every channel first verifies the invoking frame is the
// app origin. This rejects IPC from any frame that was (e.g. via redirect)
// navigated to a foreign origin, so the bridge cannot be driven from untrusted
// content.
function registerIpc(appCore: AppCore): void {
  const origin = appOrigin();
  const handle = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      let senderOrigin = '';
      try {
        senderOrigin = new URL(event.senderFrame?.url ?? '').origin;
      } catch {
        senderOrigin = '';
      }
      if (senderOrigin !== origin) {
        throw new Error(`IPC ${channel} rejected: untrusted sender origin`);
      }
      return fn(event, ...args);
    });
  };

  handle(IpcChannels.settingsGet, () => appCore.settings.get());
  handle(IpcChannels.settingsSet, (_e, update) => {
    const next = appCore.settings.set(update);
    appCore.mcpPrompts.reset(); // server URL / auth may have changed
    return next;
  });

  handle(IpcChannels.appVersion, () => app.getVersion());

  handle(IpcChannels.promptsList, () => appCore.listPrompts());
  handle(IpcChannels.orchestratorProfiles, () => appCore.listOrchestratorProfiles());
  handle(IpcChannels.citationGet, (_e, ref) => appCore.getCitation(ref));

  handle(IpcChannels.threadsList, () => appCore.listThreads());
  handle(IpcChannels.threadsCreate, () => appCore.createThread());
  handle(IpcChannels.threadsDelete, (_e, threadId: string) => appCore.deleteThread(threadId));
  handle(IpcChannels.threadsPatch, (_e, threadId: string, update: Partial<ThreadMeta>) =>
    appCore.patchThread(threadId, update),
  );
  handle(IpcChannels.threadsMessages, (_e, threadId: string) => appCore.getMessages(threadId));

  handle(IpcChannels.chatSend, (_e, request: SendMessageRequest) => appCore.sendMessage(request));
  handle(IpcChannels.chatInterrupt, (_e, threadId: string) => appCore.agent.interrupt(threadId));
  handle(IpcChannels.chatSubmitClarification, (_e, _threadId: string, toolUseId: string, answer: string) =>
    appCore.agent.resolveClarification(toolUseId, answer),
  );

  handle(IpcChannels.feedbackSubmit, (_e, request: FeedbackRequest) => appCore.submitFeedback(request));

  handle(IpcChannels.authStatus, () => appCore.authStatus());
  handle(IpcChannels.authSignin, () => appCore.serverAuth.signIn());
  handle(IpcChannels.authSignout, () => appCore.serverAuth.signOut());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    const userDataDir = app.getPath('userData');
    const canEncrypt = safeStorage.isEncryptionAvailable();
    log(
      'startup',
      `Yvoke - Desktop v${app.getVersion()} | electron ${process.versions.electron} | node ${process.versions.node} | ` +
        `agent-sdk ${packageVersion('@anthropic-ai/claude-agent-sdk')} | ` +
        `mcp-sdk ${packageVersion('@modelcontextprotocol/sdk/client/index.js')} | ` +
        `debug=${!!process.env.ELECTRON_RENDERER_URL || process.env.CLAUDE_DEBUG === '1'} | userData=${userDataDir} | encryptedStore=${canEncrypt}`,
    );
    core = new AppCore({
      userDataDir,
      emitAgentEvent: (event) => send(IpcChannels.agentEvent, event),
      emitSyncEvent: (event) => send(IpcChannels.syncEvent, event),
      openBrowser: (url) => openExternalSafe(url),
      tokenCache: canEncrypt
        ? fileTokenCache(
            path.join(userDataDir, 'msal-cache.bin'),
            (plain) => safeStorage.encryptString(plain),
            (cipher) => safeStorage.decryptString(cipher),
          )
        : null,
    });
    registerIpc(core);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    core?.dispose();
  });
}
