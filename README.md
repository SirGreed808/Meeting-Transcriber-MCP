# meeting-transcriber-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that records meeting audio, transcribes it via OpenAI Whisper, and exposes the transcripts as native Claude Code tools.

Record a meeting, stop it, and ask Claude to summarize, extract action items, or search across past transcripts — all without leaving your terminal.

---

## What it does

| Tool | Description |
|---|---|
| `list_audio_devices` | Lists available mic and system audio devices |
| `start_recording` | Starts capturing audio (mic or system loopback) |
| `stop_and_transcribe` | Stops recording, transcribes via Whisper, saves to disk |
| `list_meetings` | Lists all saved meeting transcripts |
| `get_transcript` | Reads a full transcript by meeting ID |
| `delete_meeting` | Removes a transcript and its metadata |

---

## Requirements

- **Node.js** v18+
- **OpenAI API key** — for Whisper transcription (~$0.006/min)
- **Windows** — audio capture uses WASAPI/DirectShow (Mac/Linux support planned)
- **Claude Code** — [install here](https://claude.ai/code)

No system ffmpeg install needed — the bundled `ffmpeg-static` package handles it.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/MrShannon101/meeting-transcriber-mcp.git
cd meeting-transcriber-mcp
npm install
```

### 2. Register with Claude Code

Add to your Claude Code MCP config (`~/.claude.json` or via `claude mcp add`):

```json
"meeting-transcriber": {
  "type": "stdio",
  "command": "cmd",
  "args": ["/c", "node", "/absolute/path/to/meeting-transcriber-mcp/index.js"],
  "env": {
    "OPENAI_API_KEY": "your-openai-api-key-here",
    "TRANSCRIPTS_DIR": "C:/Users/yourname/meeting-transcripts"
  }
}
```

> **Tip:** `TRANSCRIPTS_DIR` is optional — defaults to `~/meeting-transcripts`.

### 3. Restart Claude Code

The `meeting-transcriber` tools will appear in your next session.

---

## Usage

### Find your audio device

```
list_audio_devices
```

Look for your mic name in the output (e.g. `Microphone (Realtek High Definition Audio)`).

### Record a meeting

```
start_recording title="Client call - Acme" device="Microphone (Realtek High Definition Audio)"
```

For system audio (what's playing through your speakers):

```
start_recording title="Zoom call" loopback=true
```

### Stop and transcribe

```
stop_and_transcribe
```

Whisper transcribes the audio and saves it to your transcripts folder. The raw audio file is deleted after transcription.

### Work with transcripts

```
list_meetings
get_transcript id="2026-04-15T14-30-00"
```

Then ask Claude anything:
- *"Summarize this meeting"*
- *"What action items came up?"*
- *"What did we decide about the pricing?"*

---

## Transcript storage

Transcripts are saved as plain text files alongside JSON metadata:

```
~/meeting-transcripts/
  2026-04-15T14-30-00.txt    ← full transcript
  2026-04-15T14-30-00.json   ← title, date, duration, word count
```

Override the location with the `TRANSCRIPTS_DIR` env variable.

---

## Roadmap

- [ ] Mac/Linux audio capture support
- [ ] Real-time streaming transcription
- [ ] Speaker diarization (who said what)
- [ ] Auto-summary on stop

---

## License

MIT — see [LICENSE](LICENSE)
