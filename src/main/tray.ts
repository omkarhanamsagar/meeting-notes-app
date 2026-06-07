/**
 * Menu bar (system tray) integration.
 *
 * Provides a persistent menu bar icon so the user can start/stop recordings
 * and reopen the main window without it being open all the time. Updates
 * itself in response to recording state changes from the orchestrator.
 *
 * Uses a text-only label for v1 (no icon asset required); when the user has
 * a proper SVG/PNG mic icon, swap nativeImage.createEmpty() for an icon load.
 */

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
} from 'electron';
import { orchestrator } from './engine/orchestrator.js';
import { IPC } from '../shared/ipc-channels.js';
import type { ProcessingUpdate } from '../shared/types.js';

interface TrayDeps {
  /** Get or create the main window. Used by tray menu actions. */
  ensureWindow: () => BrowserWindow;
}

export class MenuBarTray {
  private tray: Tray | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastStage: ProcessingUpdate['stage'] = 'idle';
  private deps: TrayDeps;

  constructor(deps: TrayDeps) {
    this.deps = deps;
  }

  init(): void {
    // Empty image + setTitle gives a text-only menu bar item on macOS. When
    // we have a proper template PNG (16x16 @1x, 32x32 @2x), swap in:
    //   nativeImage.createFromPath(path).setTemplateImage(true)
    this.tray = new Tray(nativeImage.createEmpty());
    this.tray.setToolTip('Meeting Notes');
    this.updateLabel();
    this.refreshMenu();

    // Reflect recording stage changes (recording / transcribing / etc).
    orchestrator.on('processing', (update: ProcessingUpdate) => {
      this.lastStage = update.stage;
      this.updateLabel();
      this.refreshMenu();
    });

    // Tick once per second while recording so the elapsed time updates.
    this.timer = setInterval(() => {
      const state = orchestrator.getRecordingState();
      if (state.active) this.updateLabel();
    }, 1000);
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tray) this.tray.destroy();
    this.tray = null;
  }

  private updateLabel(): void {
    if (!this.tray) return;
    const state = orchestrator.getRecordingState();

    if (state.active && state.startedAt) {
      const elapsedSec = Math.floor((Date.now() - state.startedAt) / 1000);
      this.tray.setTitle(`● ${formatElapsed(elapsedSec)}`);
    } else if (this.lastStage === 'transcribing') {
      this.tray.setTitle('… transcribing');
    } else if (this.lastStage === 'summarizing') {
      this.tray.setTitle('… summarizing');
    } else {
      // Idle: keep it minimal. A small dot is unobtrusive.
      this.tray.setTitle('●');
    }
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const state = orchestrator.getRecordingState();

    const items: MenuItemConstructorOptions[] = [];

    if (state.active) {
      items.push({
        label: `Recording: ${state.title ?? 'Untitled'}`,
        enabled: false,
      });
      items.push({
        label: 'Stop recording',
        click: () => {
          void orchestrator.stopRecording().catch((err: unknown) => {
            console.error('Failed to stop recording from tray', err);
          });
        },
      });
    } else {
      items.push({
        label: 'Start new recording…',
        accelerator: 'Cmd+Shift+R',
        click: () => this.openStartRecordingDialog(),
      });
    }

    items.push({ type: 'separator' });
    items.push({
      label: 'Open Meeting Notes',
      click: () => this.showWindow(),
    });
    items.push({
      label: 'Settings…',
      click: () => {
        this.showWindow();
        const win = this.deps.ensureWindow();
        win.webContents.send(IPC.Events.OpenSettings);
      },
    });
    items.push({ type: 'separator' });
    items.push({ label: 'Quit', role: 'quit' });

    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  private showWindow(): void {
    const win = this.deps.ensureWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // On macOS, also bring the app to the foreground so Cmd+Tab works.
    if (process.platform === 'darwin') app.dock?.show();
  }

  private openStartRecordingDialog(): void {
    this.showWindow();
    const win = this.deps.ensureWindow();
    // Wait a tick to ensure the renderer has focus before showing modal.
    setTimeout(() => {
      win.webContents.send(IPC.Events.OpenStartRecording);
    }, 100);
  }
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
