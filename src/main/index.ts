import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, nativeTheme, safeStorage, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { IpcChannels } from '../shared/ipc';
import { DEFAULT_APPEARANCE } from '../shared/types';
import type {
  FeedbackRequest,
  PlaybookValidationRequest,
  SendMessageRequest,
  ThemePreference,
  ThreadMeta,
} from '../shared/types';
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

/**
 * The renderer's `--canvas` token, duplicated here as a plain literal. The window's own
 * background paints before the first frame of HTML exists, so this is what the user sees on a
 * cold start — leaving it at the Chromium default is the "white rectangle for ~200ms" bug.
 * Keep both values in step with :root / prefers-color-scheme in styles.css.
 */
const CANVAS_LIGHT = '#f3f2f2';
const CANVAS_DARK = '#171514';
const PANE_LIGHT = '#f8f4f4';
const PANE_DARK = '#1f1c1b';
const TEXT_LIGHT = '#201e1d';
const TEXT_DARK = '#f4f1f0';

/** Height of the renderer's custom titlebar; the Windows control overlay has to match it. */
const TITLEBAR_HEIGHT = 40;

/**
 * App icon for an UNPACKAGED run only.
 *
 * A packaged build takes its icon from the bundle (macOS .app) or the executable (Windows),
 * both stamped by electron-builder from build/icon.png. `npm run dev` launches Electron's own
 * binary instead, so without this the dock and taskbar show the generic Electron logo the whole
 * time anyone is working on the app. Returns undefined when packaged (or when the master is
 * missing) so the platform's own icon always wins.
 */
function devIconPath(): string | undefined {
  if (app.isPackaged) return undefined;
  const file = path.join(app.getAppPath(), 'build', 'icon.png');
  return fs.existsSync(file) ? file : undefined;
}

function canvasColor(): string {
  return nativeTheme.shouldUseDarkColors ? CANVAS_DARK : CANVAS_LIGHT;
}

/**
 * Native window chrome for the renderer's own titlebar. macOS keeps the traffic lights and
 * insets them into the 40px bar; Windows draws its control cluster as a themed overlay in the
 * same strip. Anywhere else the OS frame stays, and the renderer's bar is simply a header.
 */
function titleBarOverlayColors(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? PANE_DARK : PANE_LIGHT,
    symbolColor: dark ? TEXT_DARK : TEXT_LIGHT,
    height: TITLEBAR_HEIGHT,
  };
}

/**
 * Point Chromium at the user's choice. 'system' is the default and stays live: themeSource
 * 'system' keeps tracking the OS appearance for the life of the process, which is what makes a
 * 6pm scheduled switch reach an already-open window. Setting it also flips
 * `prefers-color-scheme` inside the renderer, so the CSS needs no separate channel.
 */
function applyTheme(preference: ThemePreference): void {
  nativeTheme.themeSource = preference;
}

/** Re-tint the native surfaces after a theme change (the CSS follows on its own). */
function syncWindowChrome(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(canvasColor());
  if (process.platform === 'win32') {
    try {
      mainWindow.setTitleBarOverlay(titleBarOverlayColors());
    } catch {
      // Only meaningful when the window was created with a titleBarOverlay.
    }
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const devIcon = devIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Yvoke - Desktop',
    // Windows/Linux read the window icon from here; macOS uses the dock icon set below.
    ...(devIcon && !isMac ? { icon: devIcon } : {}),
    // Painted before the renderer's first frame; without it a cold start flashes white.
    backgroundColor: canvasColor(),
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : isWindows
        ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlayColors() }
        : {}),
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
    applyTheme(next.appearance?.theme ?? DEFAULT_APPEARANCE.theme);
    syncWindowChrome();
    return next;
  });

  handle(IpcChannels.appVersion, () => app.getVersion());

  handle(IpcChannels.promptsList, () => appCore.listPrompts());
  handle(IpcChannels.orchestratorProfiles, () => appCore.listOrchestratorProfiles());
  handle(IpcChannels.playbookValidate, (_e, request: PlaybookValidationRequest) =>
    appCore.validatePlaybook(request),
  );
  handle(IpcChannels.citationGet, (_e, ref) => appCore.getCitation(ref));

  handle(IpcChannels.threadsList, () => appCore.listThreads());
  handle(IpcChannels.threadsCreate, () => appCore.createThread());
  handle(IpcChannels.threadsDelete, (_e, threadId: string) => appCore.deleteThread(threadId));
  handle(IpcChannels.threadsPatch, (_e, threadId: string, update: Partial<ThreadMeta>) =>
    appCore.patchThread(threadId, update),
  );
  handle(IpcChannels.threadsMessages, (_e, threadId: string) => appCore.getMessages(threadId));
  handle(IpcChannels.threadsSearch, (_e, query: string) => appCore.searchThreads(String(query ?? '')));

  handle(IpcChannels.chatSend, (_e, request: SendMessageRequest) => appCore.sendMessage(request));
  handle(IpcChannels.chatInterrupt, (_e, threadId: string) => appCore.agent.interrupt(threadId));
  handle(IpcChannels.chatSubmitClarification, (_e, _threadId: string, toolUseId: string, answer: string) =>
    appCore.agent.resolveClarification(toolUseId, answer),
  );

  handle(IpcChannels.feedbackSubmit, (_e, request: FeedbackRequest) => appCore.submitFeedback(request));

  handle(IpcChannels.authStatus, () => appCore.authStatus());
  handle(IpcChannels.authSignin, () => appCore.serverAuth.signIn());
  handle(IpcChannels.authSignout, () => appCore.serverAuth.signOut());
  handle(IpcChannels.clipboardWriteImage, (_e, dataUrl: string) => {
    // createFromDataURL yields an *empty* NativeImage for anything it cannot decode rather than
    // throwing, and writeImage would then hand the OS a blank — silently replacing whatever the
    // user had on their clipboard while the caller sees a success. Refuse instead, so the copy
    // button reports the failure.
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(dataUrl)) {
      throw new Error('Clipboard image must be a base64 PNG, JPEG, GIF or WebP data URL.');
    }
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) {
      throw new Error('Clipboard image could not be decoded.');
    }
    clipboard.writeImage(image);
  });
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
    // Resolve the theme BEFORE the window is constructed so its backgroundColor is already
    // right; doing it after would reintroduce the cold-start flash this is here to prevent.
    applyTheme(core.settings.get().appearance?.theme ?? DEFAULT_APPEARANCE.theme);
    const devIcon = devIconPath();
    if (devIcon) app.dock?.setIcon(devIcon);
    // Fires when the OS appearance changes under themeSource 'system' (and on an explicit
    // switch), which is what keeps the native frame from staying light around a dark app.
    nativeTheme.on('updated', syncWindowChrome);
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
