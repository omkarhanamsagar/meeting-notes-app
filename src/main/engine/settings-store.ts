/**
 * Secure storage for the user's Claude (Anthropic) API key.
 *
 * The key is encrypted with Electron's safeStorage — backed by the macOS
 * Keychain — and only the ciphertext is written to `<dataDir>/secrets.json`.
 * The raw key never touches disk. An `ANTHROPIC_API_KEY` env var, if present,
 * takes precedence over the saved key so power users (and the companion CLI)
 * keep working unchanged.
 *
 * Callers should resolve the key through [getAnthropicApiKey] and pass it to
 * `new Anthropic({ apiKey })` rather than relying on the SDK's implicit env
 * lookup — otherwise a key saved via Settings would be invisible to the SDK.
 */

import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { dataDir } from './config.js';
import type { ApiKeyStatus } from '../../shared/types.js';

interface SecretsFile {
  /** base64-encoded safeStorage ciphertext of the Anthropic API key. */
  anthropicApiKeyEnc?: string;
}

function filePath(): string {
  return path.join(dataDir(), 'secrets.json');
}

function readSecretsFile(): SecretsFile {
  const p = filePath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SecretsFile;
  } catch {
    return {};
  }
}

function writeSecretsFile(file: SecretsFile): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(file, null, 2));
}

/** The decrypted key saved via Settings, or null if none is stored / it can't
 *  be decrypted (e.g. the Keychain entry was removed). */
function storedApiKey(): string | null {
  const enc = readSecretsFile().anthropicApiKeyEnc;
  if (!enc) return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(enc, 'base64')).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Anthropic API key from (in order): the `ANTHROPIC_API_KEY`
 * env var, then the key saved via Settings. Returns null if neither is set.
 */
export function getAnthropicApiKey(): string | null {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return envKey;
  return storedApiKey();
}

/** Persist a new key (encrypted). Pass an empty string to clear the saved key. */
export function setAnthropicApiKey(key: string): void {
  const trimmed = key.trim();
  const file = readSecretsFile();
  if (!trimmed) {
    delete file.anthropicApiKeyEnc;
    writeSecretsFile(file);
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure storage is unavailable on this system, so the API key cannot be saved safely. ' +
        'Set the ANTHROPIC_API_KEY environment variable instead.',
    );
  }
  file.anthropicApiKeyEnc = safeStorage.encryptString(trimmed).toString('base64');
  writeSecretsFile(file);
}

/** Current key status for the Settings UI and diagnostics (no raw key exposed). */
export function anthropicApiKeyStatus(): ApiKeyStatus {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return { source: 'env', hint: mask(envKey) };
  const stored = storedApiKey();
  if (stored) return { source: 'stored', hint: mask(stored) };
  return { source: 'none', hint: null };
}

/** Mask a key for display: keep a short head + tail, hide the middle. */
function mask(key: string): string {
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
