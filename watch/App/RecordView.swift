import SwiftUI
import WatchKit

struct RecordView: View {
    @Bindable var model: DictationModel
    /// Crown travel since the last switch. Bumps and slow drift never add up to a switch:
    /// it takes `crownThreshold` of travel in one go, and a pause resets it.
    @State private var crown = 0.0
    @State private var crownIdle: Task<Void, Never>?
    /// Set after a switch until the crown rests: one chat per turn. Without it a long turn
    /// switched twice and jumped over the middle chat (the user couldn't reach their third chat).
    @State private var crownSpent = false
    private static let crownThreshold = 2.5      // in .low sensitivity units: a deliberate turn
    private static let crownRange = 3.0
    private static let crownPause: Duration = .milliseconds(500)
    @State private var confirmDiscard = false

    /// Two pages: the mic, and one swipe left, the chat (its last messages, newest at the bottom).
    var body: some View {
        TabView(selection: $model.page) {
            NavigationStack {
                content
                    .toolbar {
                        if model.mode == nil {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button { model.showHelp = true } label: { Image(systemName: "gearshape") }
                                    .accessibilityLabel("Help and settings")
                            }
                        }
                    }
            }
            .tag(0)
            NavigationStack { ChatView(model: model) }
                .tag(1)
        }
        .tabViewStyle(.page(indexDisplayMode: .never))   // the dots sat on the reply and on chat text
        #if DEBUG
        .task {   // `-testCrown 3`: a firm crown turn a few seconds after launch
            let turn = UserDefaults.standard.double(forKey: "testCrown")
            if turn != 0 { try? await Task.sleep(for: .seconds(4)); crownTurned(turn) }
            let x = UserDefaults.standard.double(forKey: "testX")   // `-testX 5`: press the X at that second
            if x != 0 { try? await Task.sleep(for: .seconds(x)); xTapped() }
        }
        #endif
        .animation(.spring(duration: 0.4, bounce: 0.2), value: model.banner?.id)
        .onChange(of: model.page) { _, page in if page == 1 { model.dismissBanner() } }
        .sheet(isPresented: $model.showHelp) { NavigationStack { HelpView(model: model) } }
        .sheet(isPresented: $model.showChatPicker) { ChatPickerView(model: model) }
        .sheet(isPresented: $model.showHeld) { HeldView(model: model) }
        .sheet(isPresented: $model.askLongNote, onDismiss: { model.keepRecording() }) { LongNoteView(model: model) }
        .onChange(of: model.showChatPicker) { _, shown in if !shown { model.pickingForHeld = false } }
    }

    /// Four rows that never change height: the button, two lines of status, the chat, the reply.
    /// Whatever the status says, the button and the chat name stay where they were, and the corner
    /// buttons stay in their corners (they used to ride up under the clock when the text grew).
    private var content: some View {
        ZStack {
            VStack(spacing: 4) {
                button
                statusText
                    .frame(height: 32)
                targetLabel
                // A new reply shows in the reply pill's place, under the chat name: never over
                // it, and clear of the mic button and the clock.
                ZStack {   // a real box, so the row keeps its height with no reply in it
                    if let item = model.banner {
                        ReplyBanner(item: item, open: model.openBanner, dismiss: model.dismissBanner)
                            // While recording a tap still means "send": the banner is look-only then.
                            .allowsHitTesting(model.mode == nil)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    } else {
                        replyLine
                    }
                }
                .frame(height: 30)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if model.mode == .tap {
                tapToSendOverlay
            } else {
                continuousToggle
            }
        }
        .focusable(LocalSettings.crownSwitch && model.crownWorks)
        .digitalCrownRotation($crown, from: -Self.crownRange, through: Self.crownRange, by: nil,
                              sensitivity: .low, isContinuous: false, isHapticFeedbackEnabled: false)
        .onChange(of: crown) { _, value in crownTurned(value) }
    }

    /// Worn on the inside of the wrist the crown gets bumped, so it needs a firm, unbroken
    /// turn to switch chats, one chat per turn, and it does nothing while recording.
    private func crownTurned(_ value: Double) {
        crownIdle?.cancel()
        crownIdle = Task {
            try? await Task.sleep(for: Self.crownPause)
            if !Task.isCancelled { crown = 0; crownSpent = false }
        }
        guard value != 0 else { return }
        // T3 threads are tap only, since their list changes: the crown never lands on or moves off one.
        guard model.mode == nil, LocalSettings.crownSwitch, !crownSpent, model.crownWorks else { crown = 0; return }
        if abs(value) >= Self.crownThreshold {
            crownSpent = true
            let stops = model.crownChats
            let next = model.targetIndex.map { $0 + (value > 0 ? 1 : -1) } ?? 0   // off a crossed-out chat: the top
            if stops.indices.contains(next) {
                model.select(id: stops[next].id, title: stops[next].title)
                WKInterfaceDevice.current().play(.click)
            }
            crown = 0
        }
    }

    /// The chat's answer to the last note: "Waiting for reply…" (or what the agent is doing),
    /// then its first lines. Tap to open the chat page at the newest message.
    @ViewBuilder private var replyLine: some View {
        if model.mode == nil, let reply = model.reply {
            switch reply {
            case .waiting:
                Label(model.feed.history?.working?.line ?? "Waiting for reply…", systemImage: "ellipsis.bubble")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            case .done(let text, _):
                // A pill, set apart from the chat name above it, so each is its own clear target.
                Button { model.page = 1 } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrowshape.turn.up.left.fill").foregroundStyle(Theme.accent)
                        Text(ReplyView.plain(text)).lineLimit(1)
                    }
                    .font(.caption2)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 30)
                    .background(Capsule().fill(Color.white.opacity(0.14)))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 8)
                .accessibilityLabel("Reply: \(ReplyView.plain(text))")
                .accessibilityHint("Tap to open the chat")
            }
        }
    }

    /// Where this note goes: the chat's name on a solid pill, orange for a Claudeputer chat, purple
    /// for a T3 thread. Tap to pick from a list, or turn the crown firmly (idle only).
    private var targetLabel: some View {
        let t3 = model.target.isT3Target
        let gone = model.hasTarget && !t3 && model.targetGone
        let flag = t3 ? model.feed.history?.flag : gone ? model.targetGoneLabel : nil
        return Button { model.showChatPicker = true } label: {
            // One line always, so the rows around it hold still: the flag sits beside the name.
            HStack(spacing: 4) {
                Image(systemName: model.hasTarget ? "arrow.turn.up.right" : "questionmark").font(.caption2.bold())
                Text(model.targetTitle).font(.caption2.weight(.bold)).strikethrough(gone).lineLimit(1)
                if let flag { Text(flag).font(.system(size: 11)).foregroundStyle(.white.opacity(0.85)).lineLimit(1).layoutPriority(1) }
            }
            .foregroundStyle(Color.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(!model.hasTarget || gone ? Color.white.opacity(0.2) : t3 ? Theme.t3 : Theme.accent))
            .padding(.vertical, 3)
            .padding(.horizontal, 12)
            .contentShape(Rectangle())   // a finger-sized target around the small label
        }
        .buttonStyle(.plain)
        .disabled(model.mode != nil)
        .accessibilityLabel(model.hasTarget ? "Sending to \(model.targetTitle)\(flag.map { ", \($0)" } ?? "")" : "No chat picked")
        .accessibilityHint(model.mode == nil ? "Tap to choose a chat" : "")
    }

    /// Tap to start, tap again to stop and send. The live ring shows your voice level.
    private var button: some View {
        let recording = model.mode != nil
        return TimelineView(.animation(minimumInterval: 1 / 10, paused: !recording)) { context in
            let level = model.level()
            ZStack {
                // "ready" burst: a ring that flies outward the moment the mic is live
                Circle()
                    .stroke(Color.white, lineWidth: 4)
                    .keyframeAnimator(initialValue: 1.0, trigger: model.readyPulse) { ring, t in
                        ring.scaleEffect(1 + t * 0.55).opacity(1 - t)
                    } keyframes: { _ in
                        MoveKeyframe(0.0)
                        CubicKeyframe(1.0, duration: 0.7)
                    }
                // voice ring: grows with how loud you're talking
                Circle()
                    .stroke(Theme.accent.opacity(recording ? 0.35 : 0), lineWidth: 6)
                    .scaleEffect(recording ? 1.04 + level * 0.22 : 1)
                    .animation(.easeOut(duration: 0.08), value: level)
                Circle()
                    .fill(model.sentFlash ? Theme.sent : recording ? Theme.recording : Theme.idle)
                    .shadow(color: (model.sentFlash ? Color.green : recording ? Color.red : Theme.accent).opacity(0.45), radius: 10)
                    .scaleEffect(model.sentFlash ? 0.9 : 1)
                    .animation(.spring(duration: 0.3, bounce: 0.4), value: model.sentFlash)
                centerContent(recording: recording)
            }
            // Send: squeeze and bounce the button...
            .keyframeAnimator(initialValue: 1.0, trigger: model.sendPulse) { view, scale in
                view.scaleEffect(scale)
            } keyframes: { _ in
                CubicKeyframe(0.82, duration: 0.12)
                SpringKeyframe(1.0, duration: 0.45, spring: .bouncy)
            }
            // ...and fly a paper plane up and out of it.
            .overlay {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(.white)
                    .keyframeAnimator(initialValue: SendFlight(), trigger: model.sendPulse) { plane, f in
                        plane.rotationEffect(.degrees(-35)).scaleEffect(f.scale)
                            .offset(x: f.x, y: f.y).opacity(f.opacity)
                    } keyframes: { _ in
                        KeyframeTrack(\.opacity) { MoveKeyframe(1); LinearKeyframe(1, duration: 0.35); LinearKeyframe(0, duration: 0.25) }
                        KeyframeTrack(\.y) { MoveKeyframe(0); CubicKeyframe(-95, duration: 0.6) }
                        KeyframeTrack(\.x) { MoveKeyframe(0); CubicKeyframe(40, duration: 0.6) }
                        KeyframeTrack(\.scale) { MoveKeyframe(0.6); SpringKeyframe(1.1, duration: 0.25); LinearKeyframe(0.7, duration: 0.35) }
                    }
                    .allowsHitTesting(false)
            }
        }
        .frame(width: 96, height: 96)
        // Notes that haven't gone: a count on the button itself, readable without the small text.
        // Red when one needs him to pick a chat, yellow when they're only waiting on the connection.
        .overlay(alignment: .topTrailing) {
            if !recording, model.queuedCount > 0 {
                Text("\(model.queuedCount)")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(model.heldCount > 0 ? Color.white : Color.black)
                    .frame(minWidth: 26, minHeight: 26)
                    .background(Circle().fill(model.heldCount > 0 ? Color.red : Color.yellow))
                    .overlay(Circle().stroke(Color.black, lineWidth: 2))
                    .offset(x: 2, y: -2)
                    .accessibilityLabel("\(model.queuedCount) not sent")
            }
        }
        .padding(4)
        .animation(.easeInOut(duration: 0.25), value: recording)
        .contentShape(Circle())
        .onTapGesture { model.toggle() }   // a press of any length just toggles
        .accessibilityLabel(recording ? "Tap to send" : "Tap to talk")
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder private func centerContent(recording: Bool) -> some View {
        if model.sentFlash {
            Image(systemName: "checkmark")
                .font(.system(size: 40, weight: .bold))
                .foregroundStyle(.white)
                .transition(.scale.combined(with: .opacity))
        } else if recording {
            // Its own once-a-second clock: the ring's animation timeline gets throttled
            // by watchOS, which froze the counter.
            TimelineView(.periodic(from: model.recordingStarted, by: 1)) { context in
                Text(elapsed(at: context.date))
                    .font(.system(size: 26, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(.white)
            }
        } else {
            // Right after a send too: the next note doesn't wait for the upload, and a spinner
            // here made it look like it did. Progress is in the text below.
            Image(systemName: "mic.fill")
                .font(.system(size: 36, weight: .medium))
                .foregroundStyle(.white)
        }
    }

    /// Continuous on/off without opening Settings. Shown when idle, in the corner the
    /// X takes while recording (X also ends a continuous run).
    private var continuousToggle: some View {
        Color.clear
            .allowsHitTesting(false)
            .overlay(alignment: .topLeading) {
                Button { model.setContinuous(!model.continuous) } label: {
                    Image(systemName: "repeat")
                        .font(.body.bold())
                        .foregroundStyle(model.continuous ? Color.white : Color.secondary)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(model.continuous ? Theme.accent : Color.white.opacity(0.12)))
                }
                .buttonStyle(.plain)
                .padding(.top, 10)   // clear of the clock above it
                .accessibilityLabel("Continuous")
                .accessibilityValue(model.continuous ? "On" : "Off")
                .accessibilityHint("When on, sending starts the next note right away")
            }
    }

    private var tapToSendOverlay: some View {
        Color.black.opacity(0.001)
            .contentShape(Rectangle())
            .ignoresSafeArea()
            .onTapGesture { model.tapToSend() }
            .overlay(alignment: .topLeading) {
                // A slip on the X used to throw away any amount of talking at once. Past a minute it asks.
                Button { xTapped() } label: {
                    Image(systemName: "xmark").font(.body.bold())
                }
                .buttonStyle(.bordered)
                .clipShape(Circle())
                .frame(width: 40, height: 40)
                .accessibilityLabel("Cancel")
            }
            .confirmationDialog("Discard \(Self.length(model.recordedSeconds))?", isPresented: $confirmDiscard) {
                Button("Discard", role: .destructive) { model.cancel() }
                Button("Send it") { model.sendInsteadOfDiscard() }
            }
    }

    private func xTapped() {
        if model.recordedSeconds >= DictationModel.discardAsks { confirmDiscard = true } else { model.cancel() }
    }

    /// "45 s", "12 min", "1 h 5 min".
    static func length(_ seconds: TimeInterval) -> String {
        let s = Int(seconds)
        if s < 60 { return "\(s) s" }
        let m = s / 60
        return m < 60 ? "\(m) min" : m % 60 == 0 ? "\(m / 60) h" : "\(m / 60) h \(m % 60) min"
    }

    private struct StatusLine {
        var text: String
        var color: Color = .secondary
        var strong = false
        var icon: String? = nil
    }

    /// What the status rows say when idle: two lines at most. The first is what happened to the
    /// last note; the second is its text, or what is still waiting.
    private var statusLines: [StatusLine] {
        var lines: [StatusLine]
        switch model.status {
        case .ready:
            lines = [model.hasTarget && model.targetGone ? StatusLine(text: "Pick another chat", color: .yellow)
                                                         : StatusLine(text: "Tap to talk")]
        case .sending:
            lines = [model.sendingSlow ? StatusLine(text: "Slow connection, still sending…", color: .yellow)
                                       : StatusLine(text: "Sending…")]
        case .sent(let text, _):
            // Where it went, not how long it took: the one thing worth checking at a glance.
            lines = [StatusLine(text: "Sent to \(model.sentTo)", color: model.showSentTime ? .green : .secondary,
                                strong: model.showSentTime, icon: "checkmark")]
            if let note = model.stopNote { lines.append(StatusLine(text: note, color: .yellow)) }
            else if !model.hasReply, !text.isEmpty { lines.append(StatusLine(text: text, color: .white.opacity(0.75))) }
        case .empty:
            lines = [StatusLine(text: "Didn't catch anything")]
        case .tooShort:
            lines = [StatusLine(text: "Too short, not sent", color: .yellow)]
        case .queued(let reason):
            lines = [StatusLine(text: reason, color: .yellow)]
        case .failed(let reason):
            lines = [StatusLine(text: reason, color: .red)]
        case .restarting:
            lines = [StatusLine(text: "Mic busy, restarting…", color: .yellow)]
        }
        if model.heldCount > 0 {
            lines = [lines[0], StatusLine(text: "\(model.heldCount) held. Tap to choose", color: .yellow, strong: true)]
        } else if model.queuedCount > 0 {
            lines = [lines[0], StatusLine(text: "\(model.queuedCount) waiting, will retry", color: .yellow)]
        }
        return lines
    }

    @ViewBuilder private var statusText: some View {
        if model.mode != nil {
            VStack(spacing: 2) {
                // The waveform appears and animates once the mic is live: start talking.
                HStack(spacing: 5) {
                    Image(systemName: "waveform")
                        .foregroundStyle(.green)
                        .symbolEffect(.variableColor.iterative, options: .repeating)
                        .transition(.scale.combined(with: .opacity))
                    Text("Tap to send")
                }
                .font(.footnote.weight(.semibold))
                if model.micPaused {
                    Text("Mic paused for the reply").font(.caption2).foregroundStyle(.yellow).lineLimit(1).minimumScaleFactor(0.8)
                }
            }
        } else if model.sentFlash {
            Text("Sent").font(.footnote.weight(.semibold)).foregroundStyle(.green)
        } else {
            let lines = statusLines
            let rows = VStack(spacing: 1) {
                ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                    HStack(spacing: 3) {
                        if let icon = line.icon { Image(systemName: icon).font(.caption2.bold()) }
                        // One line each when there are two; a single message may wrap onto the second row.
                        Text(line.text).lineLimit(lines.count == 1 ? 2 : 1).minimumScaleFactor(0.8)
                    }
                    .font(i == 0 ? (line.strong ? .footnote.weight(.semibold) : .footnote) : (line.strong ? .caption2.weight(.semibold) : .caption2))
                    .foregroundStyle(line.color)
                }
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, 4)
            .animation(.easeOut(duration: 0.3), value: model.showSentTime)
            // Held notes: the whole status area opens them, not just the small line.
            if model.heldCount > 0 {
                Button { model.showHeld = true } label: { rows.contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Tap to choose where held notes go")
            } else {
                rows
            }
        }
    }

    private func elapsed(at date: Date) -> String {
        let s = max(0, Int(date.timeIntervalSince(model.recordingStarted)))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// Choose where notes go. Two deliberate taps (the chat name, then a row) to switch.
struct ChatPickerView: View {
    let model: DictationModel
    @Environment(\.dismiss) private var dismiss
    @State private var path: [T3Route] = []
    @State private var mainHint: String?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                mainRow
                // The chosen chat stays visible even when it left the list, crossed out if it's gone.
                if model.hasTarget, !model.target.isT3Target, model.target != model.mainChat?.id, !model.chats.contains(where: { $0.id == model.target }) {
                    row(WatchChat(id: model.target, title: model.targetTitle), gone: model.targetGone ? model.targetGoneLabel : nil)
                }
                ForEach(model.chats) { chat in row(chat) }
                if model.chats.isEmpty, !LocalSettings.t3Enabled { Text("Add more chats on your iPhone").font(.footnote).foregroundStyle(.secondary).listRowBackground(Color.clear) }
                // T3 threads have their own screen, so they can't be mistaken for Claudeputer chats.
                if LocalSettings.t3Enabled {
                    NavigationLink(value: T3Route.list) {
                        HStack {
                            Text("T3 threads").fontWeight(.semibold).lineLimit(1)
                            Spacer()
                            if model.target.isT3Target { Image(systemName: "checkmark") }
                        }
                    }
                    .listRowBackground(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.t3))
                }
            }
            .navigationTitle("Send to")
            .navigationDestination(for: T3Route.self) { route in
                switch route {
                case .list: T3ThreadsView(model: model)
                case .thread(let thread): ChatView(model: model, previewing: thread) { dismiss() }
                }
            }
        }
        #if DEBUG
        .task {   // screenshots
            let args = ProcessInfo.processInfo.arguments
            if args.contains("-openT3") { path = [.list] }
            if args.contains("-testTapMain") { try? await Task.sleep(for: .seconds(2)); tapMain() }
            if args.contains("-openT3Thread"), let first = try? await API.t3Threads().threads.last { path = [.list, .thread(first)] }
        }
        #endif
    }

    /// Always the first row, with a chat or without. Picking it picks the chat that is Main right
    /// now; if Main changes later the row updates and notes stay where they were going.
    private var mainRow: some View {
        let main = model.mainChat
        let archived = main?.state == "archived"
        return Button(action: tapMain) {
            HStack {
                Image(systemName: "star.fill").foregroundStyle(main?.canPick == true ? Theme.accent : .secondary)
                VStack(alignment: .leading, spacing: 1) {
                    if let name = main?.title, main?.state != "none" {
                        Text("Main").font(.caption2).foregroundStyle(.secondary)
                        Text(name).lineLimit(2).strikethrough(archived).foregroundStyle(archived ? .secondary : .primary)
                        if archived { Text("Archived").font(.caption2).foregroundStyle(.secondary) }
                    } else {
                        Text(main == nil ? "Main: not loaded yet" : "Main: none set").foregroundStyle(.secondary).lineLimit(2)
                    }
                    if let mainHint { Text(mainHint).font(.caption2).foregroundStyle(.yellow) }
                }
                Spacer()
                if let id = main?.id, id == model.target { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
            }
        }
        .accessibilityLabel(main?.canPick == true ? "Main, \(main?.title ?? "")" : main?.title.map { "Main, \($0), archived" } ?? "Main, none set")
    }

    private func tapMain() {
        let main = model.mainChat
        if let main, main.canPick, let id = main.id {
            model.select(id: id, title: main.title ?? "Main")
            dismiss()
        } else {
            mainHint = main?.state == "archived" ? "That chat is archived. Set a new Main in Claudeputer" : main == nil ? "Open the app with a connection to load it" : "Set a Main chat in Claudeputer"
        }
    }

    private func row(_ chat: WatchChat, gone: String? = nil) -> some View {
        Button {
            model.select(id: chat.id, title: chat.title)
            dismiss()
        } label: {
            HStack {
                Image(systemName: "bubble.left.fill").foregroundStyle(gone == nil ? Theme.accent : .secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(chat.title).lineLimit(2).strikethrough(gone != nil).foregroundStyle(gone == nil ? .primary : .secondary)
                    if let gone { Text(gone).font(.caption2).foregroundStyle(.secondary) }
                }
                Spacer()
                if chat.id == model.target { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
            }
        }
    }
}

/// Notes a chat couldn't take. They wait, never going anywhere else until he says so here: one tap
/// on a chat sends them there. It opens by itself when a chat refuses a note.
struct HeldView: View {
    let model: DictationModel
    @State private var confirmDelete = false

    var body: some View {
        ScrollView {
            VStack(spacing: 6) {
                Text("\(model.heldCount) note\(model.heldCount == 1 ? "" : "s") held").font(.headline)
                if let reason = model.heldReason {
                    Text(reason).font(.footnote).foregroundStyle(.yellow).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text("Send to:").font(.caption2).foregroundStyle(.secondary).padding(.top, 2)
                // The chat notes go to now, when it isn't on the list below (a T3 thread, or one taken off the list).
                if model.hasTarget, !model.targetGone, !model.crownChats.contains(where: { $0.id == model.target }) {
                    Button { model.sendHeldToTarget() } label: { Text(model.targetTitle).lineLimit(2) }
                        .tint(model.target.isT3Target ? Theme.t3 : Theme.accent)
                }
                ForEach(model.crownChats) { chat in
                    Button { model.sendHeld(to: chat) } label: {
                        HStack(spacing: 5) {
                            if chat.id == model.mainChat?.id { Image(systemName: "star.fill").font(.caption2) }
                            Text(chat.title).lineLimit(2)
                        }
                    }
                    .tint(Theme.accent)
                }
                if LocalSettings.t3Enabled {
                    Button("T3 threads…") { model.showHeld = false; model.pickingForHeld = true; model.showChatPicker = true }
                        .tint(Theme.t3)
                }
                Button("Delete", role: .destructive) { confirmDelete = true }
                    .padding(.top, 4)
            }
        }
        .confirmationDialog("Delete the held notes?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { model.discardHeld() }
        }
    }
}

/// A single note that ran past ten minutes was most likely left running, so the tap that would
/// have sent it asks instead. The mic is paused while this shows. Closing it any other way than
/// a button (the X, a swipe) keeps recording.
struct LongNoteView: View {
    let model: DictationModel

    var body: some View {
        ScrollView {
            VStack(spacing: 6) {
                Text("\(RecordView.length(model.longNoteSeconds)) recorded").font(.headline)
                Text("Mic paused").font(.caption2).foregroundStyle(.secondary)
                Button { model.sendLongNote() } label: { Text("Send to \(model.targetTitle)").lineLimit(2) }
                    .tint(model.target.isT3Target ? Theme.t3 : Theme.accent)
                Button("Discard", role: .destructive) { model.discardLongNote() }
                Button("Keep recording") { model.keepRecording() }
            }
        }
    }
}

/// A reply that just landed, up from the bottom for a few seconds. Tap to open the chat page
/// at it; swipe down to put it away.
struct ReplyBanner: View {
    let item: ChatHistory.Item
    let open: () -> Void
    let dismiss: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "arrowshape.turn.up.left.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.accent)
                    .padding(.top, 2)
                Text(ReplyView.plain(item.text))
                    .font(.footnote)
                    .lineLimit(1)   // it sits in the reply pill's slot; tap for the whole reply
                    .multilineTextAlignment(.leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(white: 0.17)))
            .shadow(color: .black.opacity(0.6), radius: 8, y: 3)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 6)
        .simultaneousGesture(DragGesture(minimumDistance: 12).onEnded { if $0.translation.height > 12 { dismiss() } })
        .accessibilityLabel("New reply: \(ReplyView.plain(item.text))")
        .accessibilityHint("Tap to open the chat")
    }
}

/// Paper-plane path for the send animation; invisible at rest.
struct SendFlight {
    var x = 0.0, y = 0.0, scale = 1.0, opacity = 0.0
}

enum Theme {
    static let sent = LinearGradient(colors: [Color(red: 0.30, green: 0.85, blue: 0.45), Color(red: 0.15, green: 0.65, blue: 0.35)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing)
    static let accent = Color(red: 0.85, green: 0.47, blue: 0.34)            // Claude orange
    static let t3 = Color(red: 0.55, green: 0.36, blue: 0.96)                // the T3 destination's purple
    static let t3Background = LinearGradient(colors: [t3.opacity(0.45), .black], startPoint: .top, endPoint: .bottom)
    /// Extra space below the clock and title before scrolled text starts.
    static let clockClearance: CGFloat = 10
    static let idle = LinearGradient(colors: [Color(red: 0.93, green: 0.56, blue: 0.40), accent],
                                     startPoint: .topLeading, endPoint: .bottomTrailing)
    static let recording = LinearGradient(colors: [Color(red: 1.0, green: 0.36, blue: 0.30), Color(red: 0.86, green: 0.18, blue: 0.20)],
                                          startPoint: .topLeading, endPoint: .bottomTrailing)
}

/// A whole reply, scrollable with the crown.
struct ReplyView: View {
    let text: String
    let chat: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                if let chat { Text(chat).font(.caption2).foregroundStyle(.secondary) }
                Text(Self.markdown(text)).font(.callout)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safeAreaPadding(.top, Theme.clockClearance)
        .navigationTitle("Reply")
    }

    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    /// One-line preview: markdown rendered, line breaks folded.
    static func plain(_ text: String) -> String {
        String(markdown(text).characters).replacingOccurrences(of: "\n", with: " ")
    }
}
