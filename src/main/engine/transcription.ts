/**
 * Whisper transcription via whisper-cli subprocess.
 *
 * Asks whisper for VTT output (which carries per-segment timestamps) and
 * writes BOTH the plain `transcript.txt` (legacy consumers) AND a
 * structured `transcript.json` containing `{ startMs, endMs, text }`
 * segments. The structured file is what the summarizer uses to slice
 * transcript windows around screenshot moments.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WHISPER_BIN, WHISPER_MODEL } from './config.js';
import type { TranscriptSegment } from '../../shared/types.js';

export class TranscriptionError extends Error {}

export function checkTranscriptionEnv(): { ok: boolean; detail: string } {
  if (!fs.existsSync(WHISPER_BIN)) {
    return { ok: false, detail: `whisper-cli not found at ${WHISPER_BIN}` };
  }
  if (!fs.existsSync(WHISPER_MODEL)) {
    return { ok: false, detail: `Whisper model not found at ${WHISPER_MODEL}` };
  }
  return { ok: true, detail: 'ok' };
}

export async function transcribe(audioPath: string): Promise<string> {
  const env = checkTranscriptionEnv();
  if (!env.ok) throw new TranscriptionError(env.detail);
  if (!fs.existsSync(audioPath)) {
    throw new TranscriptionError(`Audio file not found: ${audioPath}`);
  }

  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const stem = path.basename(audioPath, ext);
  const outputPrefix = path.join(dir, stem);
  const vttPath = `${outputPrefix}.vtt`;
  const finalTxt = path.join(dir, 'transcript.txt');
  const finalJson = path.join(dir, 'transcript.json');

  // --output-vtt gives us per-cue timestamps that we can index into for
  // the multimodal screenshot context. We still derive a plain text
  // transcript from the cues so consumers that only need text don't change.
  const args = [
    '-m', WHISPER_MODEL,
    '-f', audioPath,
    '--output-vtt',
    '-of', outputPrefix,
    '--no-prints',
    '-t', '8',
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(WHISPER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    // Drain BOTH stdout and stderr. whisper-cli writes the recognized
    // text to stdout (even with --no-prints, some builds still emit
    // status). If we don't consume it, the OS pipe buffer fills (~64 KB
    // on macOS) and the subprocess blocks indefinitely on the next
    // write — which presents as a stuck transcription at 0% CPU.
    proc.stdout.on('data', () => {
      /* drain only — we never use stdout, the .vtt file is the source */
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 32_768) stderr = stderr.slice(-32_768);
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new TranscriptionError(`whisper-cli exited ${code}: ${stderr}`));
    });
  });

  if (!fs.existsSync(vttPath)) {
    throw new TranscriptionError(`whisper-cli completed but no VTT at ${vttPath}`);
  }

  const segments = parseVtt(fs.readFileSync(vttPath, 'utf8'));
  const plainText = segments.map((s) => s.text).join(' ').trim();

  fs.writeFileSync(finalTxt, plainText + '\n');
  fs.writeFileSync(finalJson, JSON.stringify(segments, null, 2));

  // Whisper leaves the .vtt behind; tidy up so the meeting dir stays clean.
  try {
    fs.unlinkSync(vttPath);
  } catch {
    /* ignore */
  }

  return plainText;
}

/** Read `transcript.json` if present; otherwise null. */
export function loadTranscriptSegments(meetingDir: string): TranscriptSegment[] | null {
  const p = path.join(meetingDir, 'transcript.json');
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as TranscriptSegment[];
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Parse a WebVTT file produced by whisper-cli. Cues look like:
 *
 *   WEBVTT
 *
 *   00:00:00.000 --> 00:00:04.500
 *   Hello and welcome.
 *
 *   00:00:04.500 --> 00:00:08.000
 *   Today we're going to talk about...
 *
 * Returns one segment per cue with start/end in milliseconds. Multi-line
 * cue text is joined with spaces.
 */
export function parseVtt(vtt: string): TranscriptSegment[] {
  const lines = vtt.replace(/\r\n/g, '\n').split('\n');
  const cueRe = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
  const segments: TranscriptSegment[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = cueRe.exec(line);
    if (m) {
      const startMs =
        parseInt(m[1]!, 10) * 3600_000 +
        parseInt(m[2]!, 10) * 60_000 +
        parseInt(m[3]!, 10) * 1000 +
        parseInt(m[4]!, 10);
      const endMs =
        parseInt(m[5]!, 10) * 3600_000 +
        parseInt(m[6]!, 10) * 60_000 +
        parseInt(m[7]!, 10) * 1000 +
        parseInt(m[8]!, 10);
      // Consume following text lines until blank.
      i++;
      const textParts: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== '') {
        textParts.push(lines[i]!.trim());
        i++;
      }
      const text = textParts.join(' ').trim();
      if (text) segments.push({ startMs, endMs, text });
    }
    i++;
  }
  return segments;
}
