import AVFoundation
import SwiftUI
import WatchConnectivity

/// The iPhone side of Claudeputer Dictation: status, where notes go, and settings.
/// Recording happens on the watch; history loads only when opened.
@main
struct PhoneApp: App {
    // Shared, so a launch in the background (the watch asking to read a reply) has it too.
    @State private var watch = WatchLink.shared

    var body: some Scene {
        WindowGroup { HomeView(watch: watch) }
    }
}

let accent = Color(red: 0.85, green: 0.47, blue: 0.34)
let t3Purple = Color(red: 0.55, green: 0.36, blue: 0.96)

struct HomeView: View {
    let watch: WatchLink
    @State private var settings: ServerSettings?
    @State private var reachable: Bool?
    @State private var showSettings = false
    @State private var showChats = false
    @State private var t3Threads: [T3Thread] = []

    var body: some View {
        NavigationStack {
            List {
                Section("Status") {
                    statusRow("Watch", watch.status, ok: watch.ok)
                    statusRow("Server", reachable == nil ? "Checking…" : reachable! ? "Reachable" : "Can't reach it",
                              ok: reachable ?? false)
                }

                Section {
                    let main = settings?.main
                    let chats = (settings?.destinations ?? []).filter { $0.id != main?.id }
                    HStack {
                        Image(systemName: "star.fill").foregroundStyle(main?.canPick == true ? accent : .secondary)
                        if let name = main?.title, main?.state != "none" {
                            Text("Main: \(name)").strikethrough(main?.state == "archived")
                        } else {
                            Text(settings == nil ? "Main" : "Main: none set").foregroundStyle(.secondary)
                        }
                    }
                    ForEach(chats) { chat in
                        HStack {
                            Image(systemName: "bubble.left.fill").foregroundStyle(accent)
                            Text(chat.title)
                        }
                    }
                    .onDelete { offsets in
                        let remove = offsets.map { chats[$0].id }
                        let extras = (settings?.extras ?? []).filter { !remove.contains($0) }
                        Task { settings = try? await API.update(["extras": extras]) }
                    }
                    Button { showChats = true } label: { Label("Add chat", systemImage: "plus") }
                        .disabled(chats.count >= 8)
                } header: { Text("Claudeputer chats on the watch") } footer: {
                    Text("On the watch, tap the chat name to choose. It stays on the chat you last picked. Main is always there and follows your Main chat in Claudeputer. Archived and deleted chats leave on their own. Swipe to remove others.")
                }

                if !t3Threads.isEmpty {
                    Section {
                        ForEach(t3Threads) { thread in
                            HStack {
                                Image(systemName: "circle.fill").font(.caption2).foregroundStyle(t3Purple)
                                VStack(alignment: .leading) {
                                    Text(thread.title).lineLimit(2)
                                    if let project = thread.project { Text(project).font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        }
                    } header: { Text("T3 threads").foregroundStyle(t3Purple) } footer: {
                        Text("Filled from T3: threads that aren't settled or snoozed. Choose one on the watch: chat name > T3 threads.")
                    }
                }

                Section {
                    NavigationLink { HistoryView() } label: { Label("History", systemImage: "clock.arrow.circlepath") }
                }
            }
            .navigationTitle("Claudeputer Dictation")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showSettings, onDismiss: { Task { await load() } }) {
                SettingsSheet(settings: $settings)
            }
            .sheet(isPresented: $showChats) {
                ChatPicker(exclude: Set((settings?.extras ?? []) + [settings?.main?.id].compactMap { $0 })) { id in
                    let extras = (settings?.extras ?? []) + [id]
                    Task { settings = try? await API.update(["extras": extras]) }
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
        .tint(accent)
    }

    private func load() async {
        async let ok = API.health()
        settings = try? await API.settings()
        t3Threads = (try? await API.t3Threads().threads) ?? t3Threads
        reachable = await ok
    }
}

func statusRow(_ label: String, _ value: String, ok: Bool) -> some View {
    HStack {
        Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle")
            .foregroundStyle(ok ? .green : .orange)
        Text(label)
        Spacer()
        Text(value).foregroundStyle(.secondary)
    }
}

struct SettingsSheet: View {
    @Binding var settings: ServerSettings?
    @Environment(\.dismiss) private var dismiss

    static func ago(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter.withFractions.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "at some point" }
        return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: .now)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let s = settings {
                    Section {
                        Picker("Transcribe", selection: Binding(get: { s.engine }, set: { new in
                            settings?.engine = new
                            Task { settings = try? await API.update(["engine": new.rawValue]) }
                        })) {
                            ForEach(Engine.allCases) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    } header: { Text("Transcription") } footer: { Text(s.engine.detail) }

                    Section {
                        Toggle("Record when the watch app opens", isOn: Binding(get: { s.autoStart }, set: { new in
                            settings?.autoStart = new
                            Task { settings = try? await API.update(["autoStart": new]) }
                        }))
                        Toggle("Continuous", isOn: Binding(get: { s.continuous ?? false }, set: { new in
                            settings?.continuous = new
                            Task { settings = try? await API.update(["continuous": new]) }
                        }))
                    } header: { Text("Recording") } footer: {
                        Text("Record on open off: the app opens to the button. Continuous: tapping send starts the next note right away, X stops.")
                    }

                    Section {
                        Picker("When a chat is working", selection: Binding(get: { s.midTurn ?? .steer }, set: { new in
                            settings?.midTurn = new
                            Task { settings = try? await API.update(["midTurn": new.rawValue]) }
                        })) {
                            ForEach(MidTurn.allCases) { Text($0.label).tag($0) }
                        }
                    } header: { Text("Notes during a turn") } footer: {
                        Text("Steer: the agent takes your note at its next step, in Claude and Codex chats. Queue: it waits for the turn to end. Continuous notes and retries always queue, and so do T3 threads and other agents. An idle chat gets the note as usual.")
                    }

                    Section {
                        Toggle("Show replies on the watch", isOn: Binding(get: { s.replyWatch ?? true }, set: { new in
                            settings?.replyWatch = new
                            Task { settings = try? await API.update(["replyWatch": new]) }
                        }))
                        Toggle("Send replies as notifications", isOn: Binding(get: { s.replyPush ?? true }, set: { new in
                            settings?.replyPush = new
                            Task { settings = try? await API.update(["replyPush": new]) }
                        }))
                        Picker("Read replies aloud", selection: Binding(get: { s.speak ?? .phone }, set: { new in
                            settings?.speak = new
                            Task { settings = try? await API.update(["speak": new.rawValue]) }
                        })) {
                            ForEach(Speak.allCases) { Text($0.label).tag($0) }
                        }
                        Toggle("ElevenLabs voice", isOn: Binding(get: { s.voice == .elevenlabs }, set: { on in
                            let new: Voice = on ? .elevenlabs : .deepgram
                            settings?.voice = new
                            Task { settings = try? await API.update(["voice": new.rawValue]) }
                        }))
                    } header: { Text("Replies") } footer: {
                        Text("After a note is sent, the chat's answer shows on the watch under the chat name. Notifications reach the watch when the iPhone is locked. Read aloud on the iPhone plays through whatever it's connected to, like the car; a reply that arrives while you record waits until the note is sent, and starting a note stops one that's playing. In Continuous the mic pauses while it plays. ElevenLabs voice sounds better but covers about ten replies a month; then Deepgram reads them.")
                    }

                    Section {
                        Picker("Tag", selection: Binding(get: { s.tag ?? .detailed }, set: { new in
                            settings?.tag = new
                            Task { settings = try? await API.update(["tag": new.rawValue]) }
                        })) {
                            ForEach(NoteTag.allCases) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    } header: { Text("Tag notes in the chat") } footer: {
                        Text("Marks each note as watch dictation, so whoever reads the chat knows to expect mis-hearings. \"continuous\" means Continuous started that note on its own, so it may be background noise. Example: \((s.tag ?? .detailed).example)")
                    }

                    Section {
                        NavigationLink("Word fixes") { DictionaryView() }
                    } footer: { Text("Your Happy dictation dictionary. Notes use it whichever way they're transcribed.") }

                    Section("Server") {
                        Text(s.server ?? Config.base.absoluteString).font(.footnote.monospaced()).textSelection(.enabled)
                    }

                    Section {
                        LabeledContent("iPhone app", value: AppVersion.text)
                        LabeledContent("Watch app", value: s.versions?["watch"]?.version ?? "Not seen yet")
                    } header: { Text("Version") } footer: {
                        Text(s.versions?["watch"].map { "Watch version as of its last contact with the server, \(Self.ago($0.at))." } ?? "")
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(accent)
    }
}

struct ChatPicker: View {
    let exclude: Set<String>
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var chats: [Chat]?

    var body: some View {
        NavigationStack {
            List {
                Section("Recent chats") {
                    if let chats {
                        ForEach(chats.filter { !exclude.contains($0.id) }) { pickRow(id: $0.id, title: $0.title, subtitle: $0.host) }
                    } else {
                        ProgressView()
                    }
                }
            }
            .navigationTitle("Add a chat")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { chats = (try? await API.chats()) ?? [] }
        }
        .tint(accent)
    }

    private func pickRow(id: String, title: String, subtitle: String?) -> some View {
        Button {
            choose(id)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading) {
                    Text(title).foregroundStyle(.primary)
                    if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
            }
        }
    }
}

struct DictionaryView: View {
    @State private var entries: [DictionaryEntry]?

    var body: some View {
        List {
            if let entries {
                Section {
                    ForEach(entries, id: \.self) { e in
                        HStack {
                            Text(e.word)
                            Spacer()
                            Text(e.replacement ?? "").foregroundStyle(.secondary)
                        }
                    }
                } footer: { Text("Edit these in Happy's dictation dictionary settings.") }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Word fixes")
        .task { entries = (try? await API.dictionary()) ?? [] }
    }
}

struct HistoryView: View {
    @State private var notes: [Dictation]?
    @State private var error: String?

    var body: some View {
        List {
            if let notes {
                if notes.isEmpty { Text("No notes yet").foregroundStyle(.secondary) }
                ForEach(notes) { DictationRow(note: $0) }
            } else if let error {
                Text(error).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("History")
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do { notes = try await API.recent().dictations; error = nil }
        catch { self.error = "Couldn't load history: \(error.localizedDescription)" }
    }
}

struct DictationRow: View {
    let note: Dictation

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(note.text.isEmpty ? "(nothing heard)" : note.text)
            if let heard = note.heard, !heard.isEmpty, heard != note.text {
                Text("Heard: \(heard)").font(.caption).foregroundStyle(.secondary)
            }
            if let reply = note.reply {
                Label { Text((try? AttributedString(markdown: reply, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(reply)).lineLimit(8) }
                    icon: { Image(systemName: "arrowshape.turn.up.left.fill") }
                    .font(.callout).foregroundStyle(accent)
            }
            Text(meta).font(.caption2).foregroundStyle(note.status == "error" ? .red : .secondary)
            if let error = note.error { Text(error).font(.caption2).foregroundStyle(.orange) }
        }
        .padding(.vertical, 2)
    }

    private var meta: String {
        var parts: [String] = []
        if let date = ISO8601DateFormatter.withFractions.date(from: note.at) {
            parts.append(date.formatted(date: .abbreviated, time: .shortened))
        }
        if let s = note.seconds { parts.append("\(Int(s.rounded())) s") }
        if let e = note.engine { parts.append(e == "local" ? "on my server" : "cloud") }
        if let chat = note.chat { parts.append(chat) }
        if let ms = note.sendMs { parts.append(String(format: "sent in %.1f s", Double(ms) / 1000)) }
        if note.status != "sent" { parts.append(note.status) }
        return parts.joined(separator: " · ")
    }
}

extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

/// Watch pairing and install state from WatchConnectivity.
@MainActor @Observable
final class WatchLink: NSObject, WCSessionDelegate {
    static let shared = WatchLink()
    private(set) var status = "Checking…"
    private(set) var ok = false

    override init() {
        super.init()
        guard WCSession.isSupported() else { status = "Not supported"; return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private func refresh(_ s: WCSession) {
        if !s.isPaired { status = "No watch paired"; ok = false }
        else if !s.isWatchAppInstalled { status = "App not on watch"; ok = false }
        else { status = s.isReachable ? "Connected" : "App installed"; ok = true }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.refresh(session) }
    }
    nonisolated func sessionWatchStateDidChange(_ session: WCSession) { Task { @MainActor in self.refresh(session) } }
    nonisolated func sessionReachabilityDidChange(_ session: WCSession) { Task { @MainActor in self.refresh(session) } }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    /// The watch asks to read a reply aloud here, so it plays through the car.
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let clip = message["stop"] as? String {
            Task { @MainActor in ReplyPlayer.shared.stop(clip) }
            return
        }
        guard let clip = message["play"] as? String else { return }
        Task { @MainActor in await ReplyPlayer.shared.play(clip) }
    }
}

/// Plays a reply on the iPhone (whatever it's connected to: the car, AirPods, the speaker),
/// ducking music, then tells the watch it's done so Continuous turns its mic back on.
@MainActor
final class ReplyPlayer: NSObject, AVAudioPlayerDelegate {
    static let shared = ReplyPlayer()
    private var player: AVAudioPlayer?
    private var clip: String?
    private var wanted: String?   // the reply being fetched or played; a stop clears it

    func play(_ clip: String) async {
        let task = UIApplication.shared.beginBackgroundTask()
        defer { UIApplication.shared.endBackgroundTask(task) }
        wanted = clip
        let data = try? await API.speech(clip: clip)
        guard wanted == clip else { return }   // stopped, or a newer reply, while it downloaded
        guard let data, let p = try? AVAudioPlayer(data: data) else { done(clip); return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        player?.stop()
        self.clip = clip
        player = p
        p.delegate = self
        if !p.play() { finished() }
    }

    /// A new note started on the watch. Stops only the reply the watch knows about.
    func stop(_ clip: String) {
        guard wanted == clip else { return }
        wanted = nil
        self.clip = nil
        player?.stop()
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finished() }
    }

    private func finished() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if let clip { done(clip) }
        clip = nil
        wanted = nil
        player = nil
    }

    private func done(_ clip: String) {
        guard WCSession.default.isReachable else { return }
        WCSession.default.sendMessage(["done": clip], replyHandler: nil, errorHandler: nil)
    }
}
