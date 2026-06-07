/**
 * Electron main process entry point.
 *
 * Creates the main app window, sets up IPC handlers, and ensures the
 * ANTHROPIC_API_KEY env var is loaded from the user's shell when the app
 * is launched from Finder (which doesn't inherit shell env).
 */

import { app, BrowserWindow, net, protocol, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { registerIpc } from './ipc.js';
import { ensureDirs } from './engine/storage.js';
import { runMigrations } from './engine/migration.js';
import { MenuBarTray } from './tray.js';
import { calendarService } from './calendar/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let tray: MenuBarTray | null = null;

/**
 * Register the `attachment://` custom protocol so the renderer can embed
 * screenshots that live under the user's data directory. Without this,
 * Chromium refuses to load `file://` URLs from an `http://localhost`
 * dev origin (and from packaged `file://` it works but is brittle).
 *
 * Usage from the renderer: <img src="attachment:///absolute/path/to/img.png">.
 * The leading `//` followed by the absolute path is required by Electron's
 * URL parser.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'attachment',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * When you launch a Mac app from Finder, it doesn't inherit env vars from
 * your shell rc — so ANTHROPIC_API_KEY etc. are missing even though they're
 * set when you run from Terminal. We fix that by spawning a login shell
 * once at startup and slurping the env back.
 *
 * Skipped if launched from a terminal (already has the env).
 */
function inheritShellEnv(): void {
  // If the key vars are already present (terminal launch), no-op.
  if (process.env.ANTHROPIC_API_KEY) return;
  try {
    const shellPath = process.env.SHELL || '/bin/zsh';
    const out = execSync(`${shellPath} -ilc 'env'`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.split('\n')) {
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const k = line.slice(0, idx);
      const v = line.slice(idx + 1);
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch (err) {
    console.warn('Could not import shell env:', err);
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // External links open in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window doesn't quit; we keep the tray alive in the background.
  win.on('closed', () => {
    mainWindow = null;
  });

  // In dev, electron-vite serves the renderer at a localhost URL stored
  // in ELECTRON_RENDERER_URL. In prod, load the built HTML directly.
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = createMainWindow();
  return mainWindow;
}

app.whenReady().then(() => {
  inheritShellEnv();
  ensureDirs();
  runMigrations();
  registerIpc();

  // `attachment://<absolute-path>` → load the file from disk.
  // The path comes in as the URL's hostname+pathname; we reconstruct it
  // and validate that it lives somewhere under the user's data dir to
  // avoid acting as an arbitrary file server.
  protocol.handle('attachment', (request) => {
    const url = new URL(request.url);
    // For `attachment:///Users/.../foo.png`, host is '' and pathname is the
    // absolute filesystem path. Decode in case of spaces / unicode.
    const filePath = decodeURIComponent(url.pathname);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  ensureMainWindow();

  tray = new MenuBarTray({ ensureWindow: ensureMainWindow });
  tray.init();

  // Calendar poller: no-op until the user connects, so safe to always start.
  calendarService.start();

  app.on('activate', () => {
    // macOS dock click — reopen the window if it was closed.
    ensureMainWindow();
  });
});

// On macOS, menu bar apps stay alive when all windows close (the tray is
// the entry point). On Windows/Linux there's no equivalent, so quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    tray?.destroy();
    app.quit();
  }
});

app.on('before-quit', () => {
  tray?.destroy();
  calendarService.stop();
});
