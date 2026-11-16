import AVFoundation
import SwiftUI

/// Settings. Recent notes live behind "History" and load only when opened.
struct HelpView: View {
    let model: DictationModel
    @State private var server: String = "Checking…"
    @State private var engine = LocalSettings.engine
    @State private var autoStart = LocalSettings.autoStart
    @State private var continuous = LocalSettings.continuous
    @State private var midTurn = LocalSettings.midTurn
    @State private var crownSwitch = LocalSettings.crownSwitch
    @State private var elevenLabs = false

    var body: some View {
        List {
            Section("Status") {
                row("Microphone", micText, ok: micOK)
                row("Server", server, ok: server == "Reachable")
                if model.queuedCount > 0 {
                    row("Waiting", "\(model.queuedCount) note(s) will retry", ok: false)
                }
            }

            Section {
                Picker("Transcribe", selection: $engine) {
                    ForEach(Engine.allCases) { Text($0.label).tag($0) }
                }
                .onChange(of: engine) { _, new in
                    LocalSettings.engine = new
                    Task { _ = try? await API.update(["engine": new.rawValue]) }
                }
                Toggle("Record on open", isOn: $autoStart)
                    .onChange(of: autoStart) { _, new in
                        LocalSettings.autoStart = new
                        Task { _ = try? await API.update(["autoStart": new]) }
                    }
                Toggle("Continuous", isOn: $continuous)
                    .onChange(of: continuous) { _, new in
                        if new != model.continuous { model.setContinuous(new) }
                    }
                Picker("When a chat is working", selection: $midTurn) {
                    ForEach(MidTurn.allCases) { Text($0.label).tag($0) }
                }
                .onChange(of: midTurn) { _, new in
                    LocalSettings.midTurn = new
                    Task { _ = try? await API.update(["midTurn": new.rawValue]) }
                }
                Toggle("Crown switches chats", isOn: $crownSwitch)
                    .onChange(of: crownSwitch) { _, new in LocalSettings.crownSwitch = new }
                Toggle("ElevenLabs voice", isOn: $elevenLabs)
                    .onChange(of: elevenLabs) { _, on in
                        Task { _ = try? await API.update(["voice": (on ? Voice.elevenlabs : .deepgram).rawValue]) }
                    }
            } header: { Text("Settings") } footer: {
                Text("Steer: a note reaches the agent at its next step. Continuous notes always queue.")
            }

            Section {
                NavigationLink("History") { WatchHistoryView() }
            }

            if !micOK {
                Section("Fix the microphone") {
                    Text("Settings > Privacy & Security > Microphone > turn on Claudeputer Dictation, then reopen it.")
                        .font(.caption2)
                }
            }

            Section {
                LabeledContent("Version", value: AppVersion.text).font(.caption2)
            }
        }
        .navigationTitle("Settings")
        .task {
            server = await model.checkServer() ? "Reachable" : "Can't reach it"
            if let s = try? await API.settings() {
                engine = s.engine; autoStart = s.autoStart; continuous = s.continuous ?? false; midTurn = s.midTurn ?? .steer; elevenLabs = s.voice == .elevenlabs
                model.syncChats()
            }
        }
    }

    private var micOK: Bool { AVAudioApplication.shared.recordPermission == .granted }

    private var micText: String {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: "Allowed"
        case .denied: "Off"
        default: "Not asked yet"
        }
    }

    private func row(_ label: String, _ value: String, ok: Bool) -> some View {
        HStack {
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(ok ? .green : .yellow)
            VStack(alignment: .leading) {
                Text(label).font(.caption2).foregroundStyle(.secondary)
                Text(value).font(.caption)
            }
        }
    }
}

/// Recent notes, fetched only when this screen opens.
struct WatchHistoryView: View {
    @State private var notes: [Dictation]?
    @State private var failed = false

    var body: some View {
        List {
            if let notes {
                if notes.isEmpty { Text("No notes yet").foregroundStyle(.secondary) }
                ForEach(notes) { note in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(note.text.isEmpty ? "(nothing heard)" : note.text).font(.caption).lineLimit(4)
                        if let reply = note.reply {
                            Text(ReplyView.markdown(reply)).font(.caption2).foregroundStyle(Theme.accent).lineLimit(6)
                        }
                        // When and where: what he's looking for in a list of notes. Not which engine heard it.
                        Text([Self.time(note.at), note.chat, note.status == "sent" ? nil : note.status].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(note.status == "error" ? .red : .secondary)
                    }
                }
            } else if failed {
                Text("Couldn't load history").foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("History")
        .task {
            do { notes = try await API.recent().dictations } catch { failed = true }
        }
    }

    /// "3:42 PM", or "Tue 3:42 PM" for another day.
    private static func time(_ iso: String) -> String? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        return ChatView.time(date)
    }
}
