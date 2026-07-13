/**
 * Paths and configuration constants.
 *
 * Defaults match the Python CLI so both tools can co-exist over the same
 * data directory if you want. Override with env vars to change behavior.
 */

import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

// Where meeting data lives on disk. By default we put it in the OS userData
// folder (e.g. ~/Library/Application Support/meeting-notes-app/data) so it
// follows Mac conventions. Override with MEETING_NOTES_DATA to share with the
// CLI (typically ~/meeting-notes/data).
function defaultDataDir(): string {
  if (process.env.MEETING_NOTES_DATA) return process.env.MEETING_NOTES_DATA;
  // app.getPath('userData') requires the app to be ready, but config is read at
  // import time. Fall back to a deterministic path when called too early.
  try {
    return path.join(app.getPath('userData'), 'data');
  } catch {
    return path.join(HOME, 'Library', 'Application Support', 'meeting-notes-app', 'data');
  }
}

export function dataDir(): string {
  return defaultDataDir();
}

export function teamsDir(): string {
  return path.join(dataDir(), 'teams');
}

/**
 * Pre-teams location for project folders. Kept around so the migration
 * step in [migration.ts] can find legacy data; production code should
 * not read from here directly.
 */
export function legacyProjectsDir(): string {
  return path.join(dataDir(), 'projects');
}

export function unfiledDir(): string {
  return path.join(dataDir(), 'unfiled');
}

export function appStatePath(): string {
  return path.join(dataDir(), 'app-state.json');
}

export const WHISPER_MODEL =
  process.env.WHISPER_MODEL ?? path.join(HOME, '.cache', 'whisper-cpp', 'ggml-medium.en.bin');

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';

// Fallback ffmpeg avfoundation input device. ":1" is the built-in mic on most
// Macs; ":0" is often a virtual device (e.g. ZoomAudioDevice). This is only the
// default when the user hasn't picked a device in Settings — the picked device
// (persisted in app-state) takes precedence. Resolved lazily so an AUDIO_DEVICE
// env var works even though it's imported into the process after startup (see
// inheritShellEnv in index.ts).
export function defaultAudioDevice(): string {
  return process.env.AUDIO_DEVICE ?? ':1';
}

// Optional explicit binary paths (useful if PATH isn't picked up from the
// user's shell rc when the app is launched via Finder).
export const FFMPEG_BIN = process.env.FFMPEG_BIN ?? '/opt/homebrew/bin/ffmpeg';
export const WHISPER_BIN = process.env.WHISPER_BIN ?? '/opt/homebrew/bin/whisper-cli';
