/**
 * Calendar polling + notification service.
 *
 * Lifecycle:
 *   - start(): begins polling Google Calendar every POLL_INTERVAL_MS, fires
 *              notifications and schedules auto-start recordings.
 *   - stop():  cancels the poll loop and any pending recording timers.
 *   - reset(): tear down and rebuild — used after the user (dis)connects.
 *
 * Notification model (matches the design the user picked):
 *   - At T-<leadMinutes> we show a native macOS notification with the title:
 *     "<Event name> · starting in <N> min". The body lists attendees.
 *   - The notification has two actions: "Yes, record" and "No, skip".
 *       Yes → arm a one-shot timer that auto-starts a recording at T-0.
 *             We also bring the app to the foreground at T-0 so the user
 *             sees the recording start happen.
 *       No  → mark the event as dismissed in the store; never re-prompt.
 *
 * Filtering: we only surface events that have at least one other attendee
 * (so calendar blocks like "Focus time" don't spam notifications).
 *
 * Dedup: each event/occurrence is keyed by `${eventId}::${startIso}`. We
 * persist both "notified" and "dismissed" sets so app restarts within the
 * lead window don't re-prompt.
 */

import { app, BrowserWindow, Notification } from 'electron';
import { google, type calendar_v3 } from 'googleapis';
import { orchestrator } from '../engine/orchestrator.js';
import { buildAuthorizedClient } from './oauth.js';
import {
  eventTrackingKey,
  patchCalendarFile,
  readCalendarFile,
  type CalendarFile,
  type CalendarLeadMinutes,
} from './store.js';

/** Poll cadence. Once a minute is plenty for human-scale meeting reminders
 *  and keeps us well under any rate limits. */
const POLL_INTERVAL_MS = 60_000;

/** How far into the future we fetch events. Always at least 2× lead window
 *  so a fresh poll never misses a soon-to-fire reminder. */
const LOOKAHEAD_MINUTES = 90;

/** Bring the window forward only if it's already alive; never spawn it. */
function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.dock?.show();
}

interface PendingArm {
  /** Event tracking key (eventId::startIso). */
  key: string;
  eventTitle: string;
  /** Timer that fires at T-0 to start the recording. */
  timer: NodeJS.Timeout;
}

export class CalendarService {
  private pollTimer: NodeJS.Timeout | null = null;
  /** Per-event pending recording timers (when user clicked Yes). */
  private armed = new Map<string, PendingArm>();
  /** Per-event open Notification instances so we can close them on action. */
  private liveNotifs = new Map<string, Notification>();

  /** Start the service if calendar is connected + enabled. No-op otherwise. */
  start(): void {
    const file = readCalendarFile();
    if (!file.settings.enabled) return;
    if (!file.settings.client || !file.tokens) return;
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => {
        console.error('[calendar] poll failed:', err);
      });
    }, POLL_INTERVAL_MS);
    // First poll immediately so the user doesn't wait a minute for the
    // service to feel "alive" after connect.
    void this.pollOnce().catch((err) => {
      console.error('[calendar] initial poll failed:', err);
    });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const arm of this.armed.values()) clearTimeout(arm.timer);
    this.armed.clear();
    for (const notif of this.liveNotifs.values()) notif.close();
    this.liveNotifs.clear();
  }

  /** Tear down and rebuild — used after the user (dis)connects or changes
   *  settings. Cheap; just clears in-memory state and re-reads config. */
  reset(): void {
    this.stop();
    this.start();
  }

  /** Run one poll iteration: fetch upcoming events, fire any notifications
   *  whose lead time has been reached, and arm recordings as needed. */
  async pollOnce(): Promise<void> {
    const file = readCalendarFile();
    if (!file.settings.enabled || !file.settings.client || !file.tokens) return;

    const auth = buildAuthorizedClient(file.settings.client, file.tokens);
    const cal = google.calendar({ version: 'v3', auth });

    const now = new Date();
    const timeMax = new Date(now.getTime() + LOOKAHEAD_MINUTES * 60_000);

    let items: calendar_v3.Schema$Event[] = [];
    try {
      const res = await cal.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true, // expand recurring series into instances
        orderBy: 'startTime',
        maxResults: 50,
      });
      items = res.data.items ?? [];
    } catch (err) {
      console.error('[calendar] events.list failed:', err);
      return;
    }

    // Stash the refreshed access token if the library rotated one for us.
    const creds = auth.credentials;
    if (creds.access_token && creds.access_token !== file.tokens.accessToken) {
      patchCalendarFile((curr) => ({
        ...curr,
        tokens: curr.tokens
          ? {
              ...curr.tokens,
              accessToken: creds.access_token ?? curr.tokens.accessToken,
              expiryDate: creds.expiry_date ?? curr.tokens.expiryDate,
            }
          : curr.tokens,
      }));
    }

    // Mark sync time.
    patchCalendarFile((curr) => ({
      ...curr,
      account: curr.account ? { ...curr.account, lastSyncAt: now.toISOString() } : curr.account,
    }));

    const leadMs = file.settings.leadMinutes * 60_000;

    for (const ev of items) {
      if (!this.eventIsCandidate(ev)) continue;
      const startIso = ev.start?.dateTime ?? null;
      if (!startIso) continue; // all-day events have only `date`, not `dateTime`
      const startMs = new Date(startIso).getTime();
      if (Number.isNaN(startMs) || startMs <= now.getTime()) continue;

      const key = eventTrackingKey(ev.id ?? `noid-${startIso}`, startIso);
      const msUntilStart = startMs - now.getTime();
      const msUntilNotify = msUntilStart - leadMs;

      // Already-handled events: skip.
      const latest = readCalendarFile(); // re-read so cross-cycle persistence is honored
      if (latest.dismissed[key]) continue;
      if (latest.notified[key]) {
        // We've already shown the notification; if it's a Yes we've also
        // armed the auto-record timer in memory, so nothing more to do.
        continue;
      }

      if (msUntilNotify > POLL_INTERVAL_MS) continue; // not yet — next cycle will catch it

      // It's time. Surface the notification.
      this.showLeadNotification(ev, startMs, file.settings.leadMinutes);
    }
  }

  private eventIsCandidate(ev: calendar_v3.Schema$Event): boolean {
    if (ev.status === 'cancelled') return false;
    const attendees = ev.attendees ?? [];
    // Need at least one attendee that isn't the user themselves. Google sets
    // `self: true` on the user's own entry.
    const others = attendees.filter((a) => !a.self);
    return others.length >= 1;
  }

  private showLeadNotification(
    ev: calendar_v3.Schema$Event,
    startMs: number,
    leadMinutes: CalendarLeadMinutes,
  ): void {
    const startIso = ev.start?.dateTime ?? new Date(startMs).toISOString();
    const key = eventTrackingKey(ev.id ?? `noid-${startIso}`, startIso);
    const title = ev.summary || '(untitled event)';

    if (!Notification.isSupported()) {
      console.warn('[calendar] native notifications not supported on this platform; skipping');
      return;
    }

    const others = (ev.attendees ?? []).filter((a) => !a.self);
    const namesList = others
      .map((a) => a.displayName || a.email || 'unknown')
      .slice(0, 4)
      .join(', ');
    const extraCount = Math.max(0, others.length - 4);
    const body = `Starting in ${leadMinutes} min · ${namesList}${
      extraCount > 0 ? ` +${extraCount}` : ''
    }`;

    // Native action buttons only work on macOS with `actions: [...]`. On
    // other platforms the notification still shows; the click handler will
    // be treated as "Yes".
    const notif = new Notification({
      title: `Record "${title}"?`,
      body,
      silent: false,
      actions: [
        { type: 'button', text: 'Yes, record' },
        { type: 'button', text: 'No, skip' },
      ],
      closeButtonText: 'Later',
    });

    notif.on('action', (_e, index) => {
      // index 0 = Yes, 1 = No (matches the `actions` array order).
      if (index === 0) this.onYes(ev, startMs);
      else this.onNo(ev, startMs);
      notif.close();
    });
    // Plain body click (no action button hit) → treat as Yes, mirroring most
    // calendar apps that interpret a click as "open / take action".
    notif.on('click', () => {
      this.onYes(ev, startMs);
      notif.close();
    });
    notif.on('close', () => {
      this.liveNotifs.delete(key);
    });

    notif.show();
    this.liveNotifs.set(key, notif);

    // Mark notified so we don't fire again on the next poll.
    patchCalendarFile((curr) => ({
      ...curr,
      notified: { ...curr.notified, [key]: new Date().toISOString() },
    }));
  }

  private onYes(ev: calendar_v3.Schema$Event, startMs: number): void {
    const startIso = ev.start?.dateTime ?? new Date(startMs).toISOString();
    const key = eventTrackingKey(ev.id ?? `noid-${startIso}`, startIso);
    const title = ev.summary || 'Meeting';

    // Cancel any existing arm for this key (idempotent).
    const existing = this.armed.get(key);
    if (existing) clearTimeout(existing.timer);

    const msUntilStart = startMs - Date.now();
    const fireIn = Math.max(0, msUntilStart);
    const timer = setTimeout(() => {
      this.armed.delete(key);
      this.startRecordingForEvent(title);
    }, fireIn);

    this.armed.set(key, { key, eventTitle: title, timer });
  }

  private onNo(ev: calendar_v3.Schema$Event, startMs: number): void {
    const startIso = ev.start?.dateTime ?? new Date(startMs).toISOString();
    const key = eventTrackingKey(ev.id ?? `noid-${startIso}`, startIso);
    patchCalendarFile((curr) => ({
      ...curr,
      dismissed: { ...curr.dismissed, [key]: new Date().toISOString() },
    }));
  }

  private startRecordingForEvent(eventTitle: string): void {
    // If a recording is already in progress (manual or from a back-to-back
    // meeting), don't clobber it.
    const state = orchestrator.getRecordingState();
    if (state.active) {
      console.warn('[calendar] skipping auto-record: a recording is already in progress');
      return;
    }
    try {
      orchestrator.startRecording({ title: eventTitle });
      // Surface the running app so the user can see the recording widget
      // (and stop it manually whenever).
      focusMainWindow();
    } catch (err) {
      console.error('[calendar] auto-record failed:', err);
    }
  }

  /** Used by the connect/disconnect IPC handlers to nudge the loop. */
  snapshotState(): CalendarFile {
    return readCalendarFile();
  }
}

export const calendarService = new CalendarService();
