# Dictate (watch-dictate)

An Apple Watch app with one job: say something, and it lands as a user message in the chat you
last picked, either a [Happy](https://github.com/slopus/happy) chat or a T3 Code thread. Hold the button and let go to send, or
open it from the Action Button, a complication or Control Center (it starts recording) and tap to send.

This is a personal project shared as-is. It was built for one setup and expects you to bring your
own server, Happy relay or T3 Code install, and Apple developer account.

```
watch (AAC 16 kHz) --HTTPS--> your server (bearer token, optional Cloudflare Access service token)
  --> watch-dictate.service :8790
        ffmpeg decode -> Deepgram Nova-3, or Parakeet TDT 0.6B v2 (local, resident)
        -> Happy dictation dictionary
        -> into the chat the clip names (Happy relay), or a T3 thread
```

There is no default chat. The watch stays on the last one picked, and a note only ever goes to the
chat it names. If that chat can't take it, the note is held on the watch until you pick another.

## Layout

```
server/
  dictate-server.mjs   HTTP receiver (/dictate, /timing, /health, /history, ...)
  lib/transcribe.mjs   ffmpeg + sherpa-onnx Parakeet
  lib/history.mjs      the watch chat page's messages + per-chat message cache
  lib/replace.mjs      word replacement (port of Happy's dictationDictionary.ts)
  lib/happy.mjs        settings, session keys, send, push timing (crypto from HAPPY_CLIENT_MODULE)
  lib/t3.mjs           T3 Code destination: send, reply following, chat page
  lib/deepgram.mjs     Deepgram Nova-3 engine (keyterms from Happy's dictionary)
  lib/store.mjs        SQLite dictation log
  lib/accepted.mjs     long notes the server owns after a 202: saved audio, retries, held notes
  lib/netlog.mjs       failed requests reported by the watch and uploads cut off
  lib/chats.mjs        the watch's chat list: Main row, archived and deleted chats
  lib/message.mjs      the note's text: tag, Continuous handling note, steer or queue
  lib/replies.mjs      follows a chat to the answer to a note
  lib/speech.mjs       replies read aloud (relay /v1/tts)
  log.mjs              print the log: node server/log.mjs [N]
  report.mjs           latency report
  watch-dictate.service  systemd template
watch/
  project.yml          XcodeGen: iPhone app + watch app + widget extension
  App/                 SwiftUI watch app: DictationModel, Recorder, Uploader (outbox + retry), NetLog
  Phone/               iPhone app: status, chats, history, settings
  Intent/              "Start Dictation" App Intent (Action Button, Control, Siri)
  Widgets/             Control Center button + complication
  Shared/              Config and Secrets (Secrets.swift is gitignored; see Secrets.swift.example)
  sync-to-mac.sh       writes Secrets.swift, rsyncs to a Mac, simulator build check
  build-phone.sh       on the Mac: build and install on the iPhone (the watch app comes with it)
  build-device.sh      on the Mac: build and install straight on the watch
  build-testflight.sh  on the Mac: archive and upload to TestFlight
```

## Setup

Server (Linux, Node 24, ffmpeg):

- `cd server && npm ci`.
- Put a random bearer token in `~/.config/watch-dictate/token`.
- Optional environment (see `dictate-server.mjs`): `WATCH_DICTATE_PORT`, `WATCH_DICTATE_PUBLIC_URL`,
  `HAPPY_SERVER_URL`, `HAPPY_CLIENT_MODULE` (a module exporting Happy's credential and crypto helpers),
  Deepgram key for the Deepgram engine.
- T3 threads: add `"t3": { "threadId": "<thread id>", "title": "T3" }` to
  `~/.local/share/watch-dictate/settings.json` and restart.
- Edit and install `server/watch-dictate.service`.
- The watch must reach the server over HTTPS from anywhere: for example a Cloudflare Tunnel or Tailscale Funnel.

App:

- Set your team id in `watch/project.yml` (`YOUR_TEAM_ID`) and bundle ids (`com.example.*`).
- Set your server URL in `watch/Shared/Config.swift`.
- Create `watch/Shared/Secrets.swift` from `Secrets.swift.example`.
- Generate the Xcode project with XcodeGen and build, or use the scripts above (they assume an SSH host
  named `your-mac`).

## Tests

`cd server && node --test test/*.test.mjs`
