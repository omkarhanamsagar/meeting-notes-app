/**
 * Parse `ffmpeg -f avfoundation -list_devices true -i ""` output to discover
 * the user's audio input devices. Used by the settings UI to let the user
 * pick a mic without editing env vars.
 */

import { spawn } from 'node:child_process';
import { FFMPEG_BIN } from './engine/config.js';
import type { AudioDevice } from '../shared/types.js';

export async function listAudioDevices(): Promise<AudioDevice[]> {
  return new Promise((resolve) => {
    // -list_devices prints to stderr and then errors out (intentionally), so
    // we ignore the exit code and just parse stderr.
    const proc = spawn(
      FFMPEG_BIN,
      ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('close', () => {
      resolve(parseAvfoundationDevices(stderr));
    });
    proc.on('error', () => resolve([]));
  });
}

function parseAvfoundationDevices(output: string): AudioDevice[] {
  // ffmpeg output looks like:
  //   AVFoundation video devices:
  //   [AVFoundation indev @ 0x123] [0] FaceTime HD Camera
  //   AVFoundation audio devices:
  //   [AVFoundation indev @ 0x123] [0] ZoomAudioDevice
  //   [AVFoundation indev @ 0x123] [1] MacBook Pro Microphone
  const lines = output.split('\n');
  let inAudio = false;
  const devices: AudioDevice[] = [];
  const lineRe = /\[(\d+)\]\s+(.+)$/;

  for (const raw of lines) {
    if (/AVFoundation video devices/i.test(raw)) {
      inAudio = false;
      continue;
    }
    if (/AVFoundation audio devices/i.test(raw)) {
      inAudio = true;
      continue;
    }
    if (!inAudio) continue;
    const m = lineRe.exec(raw.trim());
    if (m) {
      devices.push({ index: Number(m[1]), name: m[2].trim() });
    }
  }

  return devices;
}
