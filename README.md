# Meeting Notes

A personal macOS app that records your meetings, transcribes them **locally** with
Whisper, and turns them into clean summaries with Claude. Notes are organized into
a Teams → Projects → Meetings hierarchy, and you can chat with any meeting or
project (with its documents as context) and export a context bundle.

Transcription runs entirely on your machine — audio never leaves your Mac. Only the
transcript text (plus any screenshots you attach) is sent to Claude for
summarization and chat.

> **Bring your own Claude API key.** Nothing is shared or bundled — each person
> uses their own key, so each person's usage is billed to their own account. See
> [Set your Claude API key](#4-set-your-claude-api-key) below.

---

## Requirements

- **macOS on Apple Silicon** (arm64). The build target is arm64-only and unsigned.
- **[Homebrew](https://brew.sh)**
- **Node.js 18+** and npm (to build from source) — e.g. `brew install node`
- **ffmpeg** — records microphone audio
- **whisper.cpp** (`whisper-cli`) + a Whisper model file — local transcription
- **A Claude API key** — for summaries and chat ([create one](https://console.anthropic.com/settings/keys))

---

## Setup

### 1. Install the native tools

```bash
brew install ffmpeg whisper-cpp
```

This installs `ffmpeg` and `whisper-cli` at `/opt/homebrew/bin/` (the paths the app
expects by default).

### 2. Download a Whisper model

The app defaults to the `medium.en` English model (~1.5 GB) at
`~/.cache/whisper-cpp/ggml-medium.en.bin`:

```bash
mkdir -p ~/.cache/whisper-cpp
curl -L -o ~/.cache/whisper-cpp/ggml-medium.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin
```

Want a smaller/faster model? Download a different one (e.g. `ggml-small.en.bin`) and
point `WHISPER_MODEL` at it (see [Configuration](#configuration)).

### 3. Build and install the app

```bash
git clone https://github.com/omkarhanamsagar/meeting-notes-app.git
cd meeting-notes-app
npm install
npm run install:local
```

`install:local` builds the app and copies it to `~/Applications/Meeting Notes.app`.
Launch it from Spotlight (`Cmd+Space` → "Meeting Notes") or:

```bash
open "$HOME/Applications/Meeting Notes.app"
```

Because the build is **unsigned**, the first launch may be blocked by Gatekeeper.
If macOS says the app "cannot be opened", right-click the app → **Open** → **Open**,
or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "$HOME/Applications/Meeting Notes.app"
```

For local development instead of installing, run `npm run dev`.

### 4. Set your Claude API key

1. Create a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
2. Open the app → **Settings** (gear / menu-bar icon) → **Claude API key**.
3. Paste the key and click **Save**.

The key is encrypted with your macOS Keychain (via Electron `safeStorage`) and
stored locally — it never leaves your Mac and is never committed anywhere.

> Prefer environment variables? Export `ANTHROPIC_API_KEY` in your shell rc
> (`~/.zshrc`) instead — it takes precedence over the saved key, and the app pulls
> it in even when launched from Finder.

### 5. Grant microphone access

The first time you record, macOS will prompt for microphone permission. Allow it.

---

## Usage

1. Create a **Team**, then a **Project** inside it.
2. Click **Record** to start capturing a meeting. Stop when you're done.
3. The app transcribes locally (Whisper), then summarizes with Claude. You'll see
   the meeting appear with a summary, transcript, and editable notes.
4. Open any meeting or project and use **Chat** to ask questions — project
   documents and prior meeting summaries are included as context.
5. **Export** a project/meeting as a zip bundle (raw materials + an AI briefing).

**Choosing the microphone:** open **Settings → Audio input** and pick a device
from the dropdown. The change applies on your next recording — no restart needed.
(You can still set `AUDIO_DEVICE` in your shell as a fallback default; the
in-app selection takes precedence over it.)

**Recording the other side of a call:** by default the app records your
**microphone** only. To capture what other participants say, route system audio
through a virtual device like [BlackHole](https://github.com/ExistentialAudio/BlackHole)
(or an aggregate device), then select that device in **Settings → Audio input**.

---

## Optional: Google Calendar reminders

Connect Google Calendar to get a notification a few minutes before each meeting,
with a one-click **"Yes, record"** that auto-starts a recording.

In **Settings → Google Calendar**, create an OAuth **Desktop app** client in the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials), enable
the **Google Calendar API** on the project, and paste the client ID + secret. As
with the Claude key, these are stored locally and never leave your Mac.

---

## Configuration

Everything works out of the box with the defaults above. Override with environment
variables (in your shell rc) if your setup differs:

| Variable             | Default                                          | Purpose |
| -------------------- | ------------------------------------------------ | ------- |
| `ANTHROPIC_API_KEY`  | *(unset)*                                        | Claude API key. Overrides the key saved in Settings. |
| `ANTHROPIC_MODEL`    | `claude-sonnet-4-5`                              | Claude model used for summaries/chat. |
| `WHISPER_BIN`        | `/opt/homebrew/bin/whisper-cli`                  | Path to the `whisper-cli` binary. |
| `WHISPER_MODEL`      | `~/.cache/whisper-cpp/ggml-medium.en.bin`        | Path to the Whisper model file. |
| `FFMPEG_BIN`         | `/opt/homebrew/bin/ffmpeg`                       | Path to the `ffmpeg` binary. |
| `AUDIO_DEVICE`       | `:1`                                             | Fallback ffmpeg avfoundation input device index. Overridden by the device picked in Settings → Audio input. |
| `MEETING_NOTES_DATA` | `~/Library/Application Support/meeting-notes-app/data` | Where meeting data is stored. |

**Settings → Environment checks** shows a live ✓/✗ for ffmpeg, whisper-cli + model,
and your Claude key — the fastest way to see what's missing.

---

## Data & privacy

- Recordings, transcripts, summaries, and settings live under
  `~/Library/Application Support/meeting-notes-app/data` (or `MEETING_NOTES_DATA`).
- Audio is transcribed **locally**; only transcript text and attached screenshots
  are sent to Claude.
- Your Claude key and Google OAuth credentials are stored locally (the Claude key
  encrypted via the macOS Keychain) and are never committed to the repo.

---

## Development

```bash
npm run dev         # run in development with hot reload
npm run typecheck   # type-check main + renderer
npm run build       # build without packaging
npm run package     # build + package an unsigned .app into release/
```

## Tech

Electron + Vite + React + TypeScript · [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript)
for Claude · [whisper.cpp](https://github.com/ggerganov/whisper.cpp) for local
transcription · ffmpeg for capture.
