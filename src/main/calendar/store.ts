/**
 * On-disk persistence for the Google Calendar integration.
 *
 * Lives at `<dataDir>/calendar.json`. We keep it separate from app-state so
 * the schema can evolve independently and so a corrupt token file never takes
 * down the whole app.
 *
 * Schema:
 *   - settings    user-facing knobs (lead minutes, enabled flag, OAuth client)
 *   - tokens      OAuth tokens (we always store refresh_token; access_token is
 *                 refreshed automatically by the google-auth-library client)
 *   - account     metadata about who's connected (email + display name)
 *   - notified    per-event "we already showed a notification for this" log
 *   - dismissed   events the user explicitly clicked "No" on (skip-forever)
 *
 * The token file lives inside the user's macOS Application Support directory
 * which has typical user-only permissions. We don't try to encrypt it: anyone
 * with read access to that directory can already read every other app's
 * secrets, and rolling our own crypto would be worse than relying on the OS.
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../engine/config.js';

export interface CalendarOAuthClient {
  /** OAuth 2.0 Client ID from Google Cloud Console. */
  clientId: string;
  /** OAuth 2.0 Client Secret from Google Cloud Console. */
  clientSecret: string;
}

export interface CalendarTokens {
  /** Long-lived refresh token. Required to keep working past access-token TTL. */
  refreshToken: string;
  /** Short-lived access token. May be missing/expired; the SDK refreshes on demand. */
  accessToken?: string;
  /** ms-epoch when accessToken expires; advisory only. */
  expiryDate?: number;
  /** Granted scope string from Google (space-separated). */
  scope?: string;
  /** Bearer-style token type, almost always "Bearer". */
  tokenType?: string;
}

export interface CalendarAccount {
  email: string;
  /** Display name from Google profile, if available. */
  name?: string;
  /** When we last successfully fetched events. */
  lastSyncAt: string | null;
}

export type CalendarLeadMinutes = 5 | 10 | 15 | 30;

export interface CalendarSettings {
  enabled: boolean;
  leadMinutes: CalendarLeadMinutes;
  /** Connected OAuth client (set when the user pastes their credentials). */
  client: CalendarOAuthClient | null;
}

export interface CalendarFile {
  settings: CalendarSettings;
  tokens: CalendarTokens | null;
  account: CalendarAccount | null;
  /** Map of eventId+startTime -> ISO timestamp when we showed the 10-min notif.
   *  Keyed by `${eventId}::${startIso}` to avoid re-prompting if a recurring
   *  series surfaces multiple instances. */
  notified: Record<string, string>;
  /** Same key format as `notified` — these are events the user said "No" to.
   *  We never re-prompt for these. */
  dismissed: Record<string, string>;
}

const DEFAULTS: CalendarFile = {
  settings: { enabled: false, leadMinutes: 10, client: null },
  tokens: null,
  account: null,
  notified: {},
  dismissed: {},
};

function filePath(): string {
  return path.join(dataDir(), 'calendar.json');
}

export function readCalendarFile(): CalendarFile {
  const p = filePath();
  if (!fs.existsSync(p)) return cloneDefaults();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<CalendarFile>;
    return {
      settings: { ...DEFAULTS.settings, ...(raw.settings ?? {}) },
      tokens: raw.tokens ?? null,
      account: raw.account ?? null,
      notified: raw.notified ?? {},
      dismissed: raw.dismissed ?? {},
    };
  } catch {
    return cloneDefaults();
  }
}

export function writeCalendarFile(file: CalendarFile): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(file, null, 2));
}

/** Apply a partial update to the on-disk file and return the new state. */
export function patchCalendarFile(
  patch: (current: CalendarFile) => CalendarFile,
): CalendarFile {
  const current = readCalendarFile();
  const next = patch(current);
  writeCalendarFile(next);
  return next;
}

function cloneDefaults(): CalendarFile {
  return {
    settings: { ...DEFAULTS.settings },
    tokens: null,
    account: null,
    notified: {},
    dismissed: {},
  };
}

/** Stable key for the per-event tracking maps. Combines event id + start time
 *  so recurring series surface one record per occurrence (not one for the
 *  whole series). */
export function eventTrackingKey(eventId: string, startIso: string): string {
  return `${eventId}::${startIso}`;
}
