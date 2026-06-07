/**
 * Audio recording via ffmpeg child process. Mirrors recording.py — we
 * spawn ffmpeg with the avfoundation input device on macOS and write 16kHz
 * mono PCM WAV directly (the format whisper-cli expects).
 *
 * Why a subprocess instead of an Electron MediaRecorder in the renderer?
 *   - Recording must keep working when the window is minimized or hidden.
 *   - Main-process control gives a single source of truth for "am I
 *     recording?" — the renderer just observes state changes.
 *   - Avoids audio-permission UX bugs when the window loses focus.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { AUDIO_DEVICE, FFMPEG_BIN } from './config.js';

export interface RecorderOptions {
  outputPath: string;
  device?: string;
}

// stdio: [pipe stdin for 'q' quit command, ignore stdout, pipe stderr for errors]
type FfmpegProc = ChildProcessByStdio<Writable, null, Readable>;

export class Recorder {
  private readonly outputPath: string;
  private readonly device: string;
  private proc: FfmpegProc | null = null;
  private stderrBuf = '';

  constructor(opts: RecorderOptions) {
    this.outputPath = opts.outputPath;
    this.device = opts.device ?? AUDIO_DEVICE;
  }

  start(): void {
    if (this.proc) throw new Error('Recorder already started');

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'avfoundation',
      '-i', this.device,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-y',
      this.outputPath,
    ];

    this.proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'ignore', 'pipe'] }) as FfmpegProc;
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuf += chunk.toString();
      // Cap to keep memory bounded; we only care about recent errors.
      if (this.stderrBuf.length > 16_000) {
        this.stderrBuf = this.stderrBuf.slice(-8_000);
      }
    });
  }

  /**
   * Stops the recording cleanly by sending 'q' to ffmpeg's stdin so the
   * WAV header gets flushed properly. Falls back to SIGTERM/SIGKILL if it
   * doesn't exit promptly. Resolves once the file is finalized.
   */
  async stop(timeoutMs = 5000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;

    // Tell ffmpeg to quit gracefully.
    try {
      proc.stdin.write('q');
      proc.stdin.end();
    } catch {
      // pipe might already be closed; that's fine.
    }

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      proc.once('exit', cleanup);
      timer = setTimeout(() => {
        if (proc.exitCode === null) {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (proc.exitCode === null) proc.kill('SIGKILL');
          }, 1000);
        }
      }, timeoutMs);
    });

    // Exit code 255 = SIGTERM, which is normal here. Real errors will have
    // populated stderr.
    if (proc.exitCode !== 0 && proc.exitCode !== 255 && this.stderrBuf.trim()) {
      const msg = `ffmpeg exited with ${proc.exitCode}: ${this.stderrBuf.trim()}`;
      this.proc = null;
      throw new Error(msg);
    }

    this.proc = null;
  }

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }
}
