import { useEffect, useState } from 'react';
import type {
  ApiKeyStatus,
  AudioDevice,
  CalendarLeadMinutes,
  CalendarStatus,
  DoctorCheck,
} from '../../shared/types';

interface SettingsPanelProps {
  onClose: () => void;
}

const LEAD_OPTIONS: CalendarLeadMinutes[] = [5, 10, 15, 30];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [devices, setDevices] = useState<AudioDevice[] | null>(null);
  const [currentDevice, setCurrentDevice] = useState<string>('');
  const [cal, setCal] = useState<CalendarStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [calBusy, setCalBusy] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);

  useEffect(() => {
    void window.api.diagnostics.doctor().then(setChecks);
    void window.api.audio.listDevices().then(setDevices);
    void window.api.audio.getDevice().then(setCurrentDevice);
    void window.api.calendar.status().then(setCal);
    void window.api.settings.getApiKeyStatus().then(setKeyStatus);
  }, []);

  async function handleSaveApiKey(): Promise<void> {
    setKeyBusy(true);
    setKeyError(null);
    setKeySaved(false);
    try {
      const next = await window.api.settings.setApiKey(apiKeyInput.trim());
      setKeyStatus(next);
      setApiKeyInput('');
      setKeySaved(true);
      // Refresh the environment checks so the "Claude API key" row flips to ✓.
      setChecks(await window.api.diagnostics.doctor());
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setKeyBusy(false);
    }
  }

  async function handleRemoveApiKey(): Promise<void> {
    setKeyBusy(true);
    setKeyError(null);
    setKeySaved(false);
    try {
      const next = await window.api.settings.setApiKey('');
      setKeyStatus(next);
      setChecks(await window.api.diagnostics.doctor());
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setKeyBusy(false);
    }
  }

  async function handleDeviceChange(device: string): Promise<void> {
    setDeviceBusy(true);
    try {
      // Persist the selection; the resolved device is echoed back.
      setCurrentDevice(await window.api.audio.setDevice(device));
    } finally {
      setDeviceBusy(false);
    }
  }

  async function handleSaveClient(): Promise<void> {
    setCalBusy(true);
    setCalError(null);
    try {
      const next = await window.api.calendar.setClient({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setCal(next);
      setClientId('');
      setClientSecret('');
    } catch (err) {
      setCalError(err instanceof Error ? err.message : String(err));
    } finally {
      setCalBusy(false);
    }
  }

  async function handleConnect(): Promise<void> {
    setCalBusy(true);
    setCalError(null);
    try {
      setCal(await window.api.calendar.connect());
    } catch (err) {
      setCalError(err instanceof Error ? err.message : String(err));
    } finally {
      setCalBusy(false);
    }
  }

  async function handleDisconnect(): Promise<void> {
    setCalBusy(true);
    setCalError(null);
    try {
      setCal(await window.api.calendar.disconnect());
    } catch (err) {
      setCalError(err instanceof Error ? err.message : String(err));
    } finally {
      setCalBusy(false);
    }
  }

  async function handleToggleEnabled(enabled: boolean): Promise<void> {
    setCal(await window.api.calendar.updateSettings({ enabled }));
  }

  async function handleLeadChange(leadMinutes: CalendarLeadMinutes): Promise<void> {
    setCal(await window.api.calendar.updateSettings({ leadMinutes }));
  }

  async function handlePollNow(): Promise<void> {
    setCalBusy(true);
    try {
      setCal(await window.api.calendar.pollNow());
    } finally {
      setCalBusy(false);
    }
  }

  return (
    <div className="main">
      <div className="main-header">
        <div>
          <h2>Settings &amp; diagnostics</h2>
          <div className="subtitle">Environment, audio devices, and configuration</div>
        </div>
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="main-body">
        <h3 style={{ marginTop: 0 }}>Environment checks</h3>
        {!checks && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}
        {checks?.map((c) => (
          <div className="doctor-row" key={c.name}>
            <span className={`check ${c.ok ? 'doctor-ok' : 'doctor-bad'}`}>
              {c.ok ? '✓' : '✗'}
            </span>
            <span style={{ fontWeight: 500, minWidth: 180 }}>{c.name}</span>
            <span className="doctor-detail">{c.detail}</span>
          </div>
        ))}

        <h3 style={{ marginTop: 32 }}>Claude API key</h3>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
          Summaries and chat use the Claude API — transcription runs locally and needs no key.
          Everyone uses their own key: create one at{' '}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            console.anthropic.com
          </a>
          . It's encrypted in your macOS Keychain and never leaves this Mac.
        </div>

        {keyStatus?.source === 'env' && (
          <div className="doctor-row" style={{ marginBottom: 8 }}>
            <span className="check doctor-ok">✓</span>
            <span style={{ fontWeight: 500, minWidth: 180 }}>Using environment variable</span>
            <span className="doctor-detail">
              {keyStatus.hint} · from <code>ANTHROPIC_API_KEY</code>. A key saved below is only used
              if you unset it.
            </span>
          </div>
        )}

        {keyStatus?.source === 'stored' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 12,
              flexWrap: 'wrap',
            }}
          >
            <span className="check doctor-ok">✓</span>
            <span style={{ fontWeight: 500 }}>Saved</span>
            <span className="doctor-detail">{keyStatus.hint}</span>
            <button
              className="btn btn-ghost"
              onClick={() => void handleRemoveApiKey()}
              disabled={keyBusy}
              style={{ marginLeft: 'auto' }}
            >
              Remove
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 520 }}>
          <input
            className="input"
            placeholder={keyStatus?.source === 'stored' ? 'Replace key (sk-ant-…)' : 'sk-ant-…'}
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            type="password"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-primary"
            onClick={() => void handleSaveApiKey()}
            disabled={keyBusy || !apiKeyInput.trim()}
          >
            {keyBusy ? 'Saving…' : 'Save'}
          </button>
        </div>

        {keySaved && (
          <div style={{ fontSize: 12, color: 'var(--accent)', marginTop: 6 }}>
            Saved. New summaries and chats will use this key.
          </div>
        )}

        {keyError && (
          <div
            style={{
              marginTop: 8,
              padding: 10,
              borderRadius: 6,
              background: 'rgba(248, 113, 113, 0.1)',
              border: '1px solid rgba(248, 113, 113, 0.3)',
              color: '#fca5a5',
              fontSize: 13,
            }}
          >
            {keyError}
          </div>
        )}

        <h3 style={{ marginTop: 32 }}>Audio input</h3>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Pick the microphone to record from. The change takes effect on your next
          recording — no restart needed.
        </div>
        {!devices && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
        {devices && devices.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            No audio devices detected. Check that ffmpeg is installed and macOS has granted microphone permissions.
          </div>
        )}
        {devices && devices.length > 0 && (
          <select
            className="input"
            style={{ width: 'auto', minWidth: 260, padding: '6px 8px' }}
            value={currentDevice}
            disabled={deviceBusy}
            onChange={(e) => void handleDeviceChange(e.target.value)}
          >
            {/* If the resolved device isn't in the list (e.g. an env-var index
                that's since disappeared), still show it so the value is valid. */}
            {!devices.some((d) => `:${d.index}` === currentDevice) && currentDevice && (
              <option value={currentDevice}>{currentDevice} (current)</option>
            )}
            {devices.map((d) => (
              <option key={d.index} value={`:${d.index}`}>
                :{d.index} — {d.name}
              </option>
            ))}
          </select>
        )}

        <h3 style={{ marginTop: 32 }}>Google Calendar</h3>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
          Get a native notification 5–30 minutes before each meeting starts.
          Click <strong>Yes, record</strong> and Meeting Notes will auto-start a recording
          when the meeting begins. Only events with other attendees trigger reminders.
        </div>

        {!cal && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

        {cal && !cal.hasClient && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 16,
              marginBottom: 12,
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            <div style={{ fontWeight: 500, marginBottom: 6 }}>One-time setup</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
              Create an OAuth client in{' '}
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                Google Cloud Console
              </a>{' '}
              (Application type: <strong>Desktop app</strong>). Enable the{' '}
              <strong>Google Calendar API</strong> on the project. Then paste the
              client ID and secret below.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                className="input"
                placeholder="Client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
              <input
                className="input"
                placeholder="Client secret"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                type="password"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
              <div>
                <button
                  className="btn btn-primary"
                  onClick={() => void handleSaveClient()}
                  disabled={calBusy || !clientId.trim() || !clientSecret.trim()}
                >
                  Save credentials
                </button>
              </div>
            </div>
          </div>
        )}

        {cal && cal.hasClient && !cal.isConnected && (
          <div style={{ marginBottom: 12 }}>
            <button
              className="btn btn-primary"
              onClick={() => void handleConnect()}
              disabled={calBusy}
            >
              {calBusy ? 'Opening browser…' : 'Connect Google Calendar'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              Credentials saved. Click Connect to open Google's consent screen in your browser.
            </div>
          </div>
        )}

        {cal && cal.isConnected && cal.account && (
          <div style={{ marginBottom: 12 }}>
            <div className="doctor-row">
              <span className="check doctor-ok">✓</span>
              <span style={{ fontWeight: 500, minWidth: 180 }}>Connected</span>
              <span className="doctor-detail">
                {cal.account.email}
                {cal.account.lastSyncAt && (
                  <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                    · last sync {new Date(cal.account.lastSyncAt).toLocaleTimeString()}
                  </span>
                )}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={cal.isEnabled}
                  onChange={(e) => void handleToggleEnabled(e.target.checked)}
                />
                Notifications enabled
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                Notify
                <select
                  className="input"
                  style={{ width: 'auto', padding: '4px 8px' }}
                  value={cal.leadMinutes}
                  onChange={(e) =>
                    void handleLeadChange(Number(e.target.value) as CalendarLeadMinutes)
                  }
                >
                  {LEAD_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
                before
              </label>

              <button
                className="btn btn-ghost"
                onClick={() => void handlePollNow()}
                disabled={calBusy}
              >
                Sync now
              </button>

              <button
                className="btn btn-ghost"
                onClick={() => void handleDisconnect()}
                disabled={calBusy}
                style={{ marginLeft: 'auto' }}
              >
                Disconnect
              </button>
            </div>
          </div>
        )}

        {calError && (
          <div
            style={{
              marginTop: 8,
              padding: 10,
              borderRadius: 6,
              background: 'rgba(248, 113, 113, 0.1)',
              border: '1px solid rgba(248, 113, 113, 0.3)',
              color: '#fca5a5',
              fontSize: 13,
            }}
          >
            {calError}
          </div>
        )}
      </div>
    </div>
  );
}
