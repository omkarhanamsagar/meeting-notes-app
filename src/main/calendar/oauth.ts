/**
 * Google OAuth 2.0 "installed app" flow with a loopback redirect.
 *
 * The user clicks Connect in Settings; we:
 *   1. Spin up a tiny HTTP server on a free loopback port.
 *   2. Open the user's default browser to Google's consent URL with that
 *      port as the redirect_uri.
 *   3. After consent, Google redirects to http://127.0.0.1:<port>/callback?code=…
 *      Our local server captures the code, shows a "you can close this" page,
 *      and shuts down.
 *   4. We exchange the code for tokens (including a refresh_token) and fetch
 *      the user's profile to know whose calendar we connected.
 *
 * This is the standard Google-recommended flow for desktop apps. The user
 * pastes their own OAuth client credentials into Settings; nothing is
 * embedded in the binary.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { shell } from 'electron';
import { google } from 'googleapis';
import type { CalendarAccount, CalendarOAuthClient, CalendarTokens } from './store.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export class OAuthCancelled extends Error {
  constructor() {
    super('OAuth flow cancelled by user');
    this.name = 'OAuthCancelled';
  }
}

export interface ConnectResult {
  tokens: CalendarTokens;
  account: CalendarAccount;
}

interface CallbackResult {
  code: string;
  redirectUri: string;
}

/** Bind to an OS-assigned port on 127.0.0.1 and return the actual port. */
function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('Failed to bind loopback port'));
    });
  });
}

/** Run the full OAuth dance. Resolves with the persisted-shape tokens +
 *  account info. Throws OAuthCancelled if the user closes the browser
 *  without granting consent (or if the 5-min timeout elapses). */
export async function runOAuthFlow(client: CalendarOAuthClient): Promise<ConnectResult> {
  if (!client.clientId || !client.clientSecret) {
    throw new Error('Google OAuth client_id and client_secret are both required');
  }

  const expectedState = randomState();
  let resolveCallback!: (v: CallbackResult) => void;
  let rejectCallback!: (err: Error) => void;
  const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      if (error) {
        respondHtml(res, errorPage(error));
        setImmediate(() => server.close());
        rejectCallback(new Error(`Google denied authorization: ${error}`));
        return;
      }
      if (!code || state !== expectedState) {
        respondHtml(res, errorPage('Missing or invalid response from Google'));
        setImmediate(() => server.close());
        rejectCallback(new Error('Invalid OAuth callback'));
        return;
      }
      respondHtml(res, successPage());
      setImmediate(() => server.close());
      // redirectUri is filled in below before resolveCallback can ever fire,
      // because we only open the browser after pickPort + URL construction.
      resolveCallback({ code, redirectUri: redirectUri! });
    } catch (err) {
      try {
        res.statusCode = 500;
        res.end('Internal error');
      } catch {
        // ignore
      }
      rejectCallback(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const port = await listenLoopback(server);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const oauthClient = new google.auth.OAuth2(client.clientId, client.clientSecret, redirectUri);
  const authUrl = oauthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on re-auth
    scope: SCOPES,
    state: expectedState,
  });

  // Hard timeout: free the port and surface a clean cancel if the user
  // wanders off.
  const timeoutHandle = setTimeout(() => {
    if (server.listening) {
      server.close();
      rejectCallback(new OAuthCancelled());
    }
  }, FLOW_TIMEOUT_MS);

  try {
    await shell.openExternal(authUrl);
  } catch (err) {
    clearTimeout(timeoutHandle);
    server.close();
    throw err instanceof Error ? err : new Error(String(err));
  }

  let callback: CallbackResult;
  try {
    callback = await callbackPromise;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const { tokens } = await oauthClient.getToken(callback.code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. Make sure the OAuth client is configured as a "Desktop app" in Google Cloud Console, and that you fully accepted the consent screen.',
    );
  }

  const tokensOut: CalendarTokens = {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? undefined,
    expiryDate: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
    tokenType: tokens.token_type ?? undefined,
  };

  // Identify the account so we can show its email in Settings.
  oauthClient.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
  const profile = await oauth2.userinfo.get();
  const account: CalendarAccount = {
    email: profile.data.email ?? '(unknown)',
    name: profile.data.name ?? undefined,
    lastSyncAt: null,
  };

  return { tokens: tokensOut, account };
}

/** Build an authenticated OAuth2 client from persisted tokens. Used by the
 *  poller (and by anything else that calls Google APIs after the initial
 *  connect). The SDK auto-refreshes access tokens behind the scenes. */
export function buildAuthorizedClient(
  oauthClient: CalendarOAuthClient,
  tokens: CalendarTokens,
): InstanceType<typeof google.auth.OAuth2> {
  const client = new google.auth.OAuth2(oauthClient.clientId, oauthClient.clientSecret);
  client.setCredentials({
    refresh_token: tokens.refreshToken,
    access_token: tokens.accessToken,
    expiry_date: tokens.expiryDate,
    scope: tokens.scope,
    token_type: tokens.tokenType,
  });
  return client;
}

function randomState(): string {
  // 16 url-safe bytes — plenty of entropy for CSRF defense on a loopback
  // server that only lives for the duration of a single consent flow.
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function respondHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function successPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Meeting Notes — Connected</title>
<style>
  body { font: 15px -apple-system, system-ui, sans-serif; background: #0f1115; color: #e4e6eb; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 420px; padding: 32px; text-align: center; }
  .check { font-size: 48px; color: #34d399; margin-bottom: 12px; }
  h1 { font-size: 18px; margin: 8px 0; font-weight: 600; }
  p { color: #9aa0a6; margin: 8px 0 0; }
</style></head><body>
<div class="card">
  <div class="check">✓</div>
  <h1>Google Calendar connected</h1>
  <p>You can close this window and return to Meeting Notes.</p>
</div>
</body></html>`;
}

function errorPage(detail: string): string {
  const safe = String(detail).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Meeting Notes — Error</title>
<style>
  body { font: 15px -apple-system, system-ui, sans-serif; background: #0f1115; color: #e4e6eb; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 480px; padding: 32px; text-align: center; }
  .x { font-size: 48px; color: #f87171; margin-bottom: 12px; }
  h1 { font-size: 18px; margin: 8px 0; font-weight: 600; }
  p { color: #9aa0a6; margin: 8px 0 0; }
  code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
</style></head><body>
<div class="card">
  <div class="x">✗</div>
  <h1>Authorization failed</h1>
  <p><code>${safe}</code></p>
  <p>Return to Meeting Notes and try again.</p>
</div>
</body></html>`;
}
