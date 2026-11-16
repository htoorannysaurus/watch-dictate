import AVFoundation
import Foundation
import Observation
import WatchKit

/// The whole app's state. Tap to start recording, tap again to send. Opening the app
/// (from the icon, Action Button, complication, or Control Center) starts recording.
@MainActor
@Observable
final class DictationModel {
    enum Mode { case tap }

    enum Status: Equatable {
        case ready
        case sending
        case sent(text: String, ms: Int)
        case empty
        case tooShort     // under half a second: not sent, and he's told
        case queued(String)
        case failed(String)
        case restarting   // Continuous: the mic would not start; trying again
    }

    private(set) var mode: Mode?          // non-nil while recording
    private(set) var recordingStarted = Date()
    private(set) var status: Status = .ready
    private(set) var queuedCount = 0 { didSet { updateHeld() } }
    /// Bumps each time the mic is really recording; the view plays a "ready" burst on it.
    private(set) var readyPulse = 0
    /// Bumps on every send tap; the view flies a paper plane out of the button.
    private(set) var sendPulse = 0
    /// True for a moment after a recording starts ("Go ahead").
    private(set) var justStarted = false
    /// True between a send and the next recording in continuous mode (green check).
    private(set) var sentFlash = false
    private(set) var chats = LocalSettings.chats { didSet { updateWidget() } }
    private(set) var target = LocalSettings.target {
        didSet {
            updateWidget()
            if active { feed.follow(followedChat) }
        }
    }
    /// How the selected chat is marked: "ok", "archived" or "deleted".
    private(set) var targetState = LocalSettings.targetState {
        didSet {
            guard targetState != oldValue else { return }
            updateWidget()
            if active, hasLaunched { feed.follow(followedChat) }
        }
    }
    /// The Main row: Claudeputer's Main chat, or nil before the server has answered once.
    private(set) var mainChat = LocalSettings.mainChat { didSet { updateWidget() } }
    /// 0 = the mic, 1 = the chat page (swipe left, or tap the reply).
    var page = 0
    /// The chat page's messages, kept current while the app is open.
    let feed = ChatFeed()
    private var active = false
    /// Continuous: sending starts the next note. Toggled on the main screen or in Settings.
    private(set) var continuous = LocalSettings.continuous
    var showHelp = false
    /// The chat's answer to the last note sent (shown under the chat name; tap for the chat page).
    private(set) var reply: ReplyState?
    enum ReplyState: Equatable { case waiting(chat: String?), done(text: String, chat: String?) }
    var hasReply: Bool { if case .done? = reply { true } else { false } }
    /// A reply that just landed, shown as a banner for a few seconds; it stays in the chat page.
    private(set) var banner: ChatHistory.Item?
    private var bannerHide: Task<Void, Never>?
    private var replyPoll: Task<Void, Never>?
    var showChatPicker = false
    private(set) var showSentTime = false   // "Sent in X s" shows briefly, the text stays
    /// Why the last note ended on its own (mic cut off, or the length cap), shown in yellow.
    private(set) var stopNote: String?
    /// The chat the last sent note went to: "Sent to Journal".
    private(set) var sentTo = ""
    /// The send has run long enough that "Sending…" alone looks stuck.
    private(set) var sendingSlow = false
    private var sendRun = 0
    /// A tap note this long was most likely left running (every one over 20 minutes so far was room
    /// audio), so ending it asks: send, discard, or keep going. Not in Continuous, which is meant to run.
    var askLongNote = false
    private static var longNote: TimeInterval {
        #if DEBUG
        let test = UserDefaults.standard.double(forKey: "longNoteSeconds")   // `-longNoteSeconds 3`
        if test > 0 { return test }
        #endif
        return 10 * 60
    }
    /// X asks before it throws away more than this.
    static var discardAsks: TimeInterval {
        #if DEBUG
        let test = UserDefaults.standard.double(forKey: "discardAsksSeconds")   // `-discardAsksSeconds 2`
        if test > 0 { return test }
        #endif
        return 60
    }

    /// Opening the app starts recording unless turned off in settings (last-known value,
    /// refreshed from the server in the background).
    private var autoStartOnLaunch: Bool {
        LocalSettings.autoStart && !ProcessInfo.processInfo.arguments.contains("-noAutoStart")
    }
    private let recorder = Recorder()
    private let uploader = Uploader()
    private let voice = ReplyVoice()
    private var spokenClip: String?
    private var hasLaunched = false
    private var heartbeat: Task<Void, Never>?
    private var lengthCap: Task<Void, Never>?
    private var micAllowed = false
    /// A reply is being read in Continuous, so the mic is off for now. Shown on the recording screen.
    private(set) var micPaused = false
    /// A reply that became ready during a note; it's read once the note is sent.
    private var heldSpeech: (clip: String, seconds: Double)?
    /// This note was started by Continuous, not by a tap or opening the app.
    private var autoStarted = false

    /// A tap this soon after Continuous starts the next note is a late tap on the last one: ignored.
    private static let stopTapWindow: TimeInterval = 1.5
    /// No time limit on notes: they send when you tap. The only stop is the
    /// upload size: about 8 hours of audio is the most the server (and Cloudflare) takes.
    private static let noteCap: Duration = .seconds(8 * 60 * 60)
    /// After a single note the audio session stays on this long, so the next tap skips turning
    /// it back on. Nothing is recorded meanwhile; the orange dot shows. Setting: `micHold`.
    private static let micHold: Duration = .seconds(30)
    private var holdTask: Task<Void, Never>?

    init() {
        recorder.onCutOff = { [weak self] in
            MainActor.assumeIsolated { self?.cutOff() }
        }
        recorder.onInterruptionEnded = { [weak self] in
            MainActor.assumeIsolated { _ = self?.tryResume() }
        }
        recorder.onInterruptionBegan = { [weak self] in
            MainActor.assumeIsolated { self?.endHold() }
        }
        feed.onChange = { [weak self] in
            self?.noteRename()
            self?.checkReplyNow()
        }
        feed.onReply = { [weak self] item in self?.showBanner(item) }
        voice.onFinished = { [weak self] in
            guard let self else { return }
            if !askLongNote { recorder.resume() }   // the long-note question holds the mic off until he answers
            micPaused = false
            // Playing a reply here turned the session on. Between Continuous notes the next one wants it.
            if mode == nil, holdTask == nil, !sentFlash { releaseMic() }
        }
    }

    func launched() async {
        guard !hasLaunched else { return }
        hasLaunched = true
        active = true
        feed.follow(followedChat)
        #if DEBUG
        // Simulator screenshots: open on the chat page, or show a sent note with its reply.
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-chatPage") { page = 1 }
        #if DEBUG
        if args.contains("-chatPicker") || args.contains("-openT3") || args.contains("-openT3Thread") { showChatPicker = true }   // screenshots
        if args.contains("-openHeld") { Task { await flush(); showHeld = true } }
        if args.contains("-openHelp") { showHelp = true }
        // `-testReplyClip <id>` waits for that clip's reply; `-testTaps 1,9` presses the button at those seconds.
        if let clip = UserDefaults.standard.string(forKey: "testReplyClip") {
            LocalSettings.lastReplyClip = clip
            reply = .waiting(chat: "Test")
            followReply()
        }
        // `-testButton 3`: the Action Button at that second. `-testHeldPick 12`: tap the second chat on the held notes' list.
        if let presses = UserDefaults.standard.string(forKey: "testButton") {
            for second in presses.split(separator: ",").compactMap({ Double($0) }) {
                Task { try? await Task.sleep(for: .seconds(second)); actionButton() }
            }
        }
        let pick = UserDefaults.standard.double(forKey: "testHeldPick")
        if pick > 0 { Task { try? await Task.sleep(for: .seconds(pick)); if crownChats.count > 1 { sendHeld(to: crownChats[1]) } } }
        if let taps = UserDefaults.standard.string(forKey: "testTaps") {
            for second in taps.split(separator: ",").compactMap({ Double($0) }) {
                Task { try? await Task.sleep(for: .seconds(second)); toggle() }
            }
        }
        #endif
        if args.contains("-sampleBanner") {
            banner = .init(id: "sample", role: "agent", text: "Done. I logged the Taro shot as 0.4 mL in today's log and the injection sheet.", at: nil, watch: nil)
        }
        if args.contains("-sampleReply") {
            status = .sent(text: "Yeah, let's have some mock-ups made and then let's just deploy it so I can see how it feels.", ms: 900)
            reply = .done(text: "I started a new Happy chat to build this, and it has already begun working.", chat: nil)
        }
        #endif
        updateWidget()
        recorder.prepare()
        micAllowed = await Recorder.requestPermission()
        guard micAllowed else {
            status = .failed("Microphone is off. Tap the gear for help")
            showHelp = true
            return
        }
        if DictateLaunch.pending || autoStartOnLaunch {
            DictateLaunch.pending = false
            startTapMode()
        }
        if (try? await API.settings()) != nil { syncChats() }
        await flush()
    }

    func consumeLaunchRequest() {
        guard DictateLaunch.pending, hasLaunched else { return }
        DictateLaunch.pending = false
        actionButton()
    }

    /// Action Button (the Control) or complication: start recording, or while recording send
    /// this note now. In Continuous the next note starts as usual, so it keeps listening. A
    /// press right after Continuous started the next note has nothing to send yet; it's ignored.
    private func actionButton() {
        guard mode != nil else { startTapMode(); return }
        if autoStarted, Date().timeIntervalSince(recordingStarted) < Self.stopTapWindow { return }
        end(by: .button)
    }

    /// Wrist down or app in the background: stop following the chat.
    func wentInactive() {
        active = false
        NetLog.shared.lastInactiveAt = Date()
        feed.stop()
        // The reply check too: with the wrist down a push carries the answer, and becameActive
        // picks the check back up. Left running it asked the server every 2 s for up to 20 minutes.
        replyPoll?.cancel()
        replyPoll = nil
        endHold()   // the hold's timer can't be trusted to run once the app is in the background
    }

    func becameActive() {
        active = true
        if hasLaunched { feed.follow(followedChat) }
        tryResume()
        // Pick up a microphone permission changed in Settings without a relaunch.
        if hasLaunched, !micAllowed, AVAudioApplication.shared.recordPermission == .granted {
            micAllowed = true
            status = .ready
        }
        consumeLaunchRequest()
        askAboutHeld()
        if case .waiting? = reply { followReply() }
        Task {
            // Pick up chats added on the phone.
            if (try? await API.settings()) != nil { syncChats() }
            await flush()
        }
    }

    var targetTitle: String { LocalSettings.targetTitle ?? "Pick a chat" }
    var hasTarget: Bool { !target.isEmpty }
    /// The selected chat was archived or deleted: it stays selected, crossed out, until he picks another.
    var targetGone: Bool { targetState == "archived" || targetState == "deleted" }
    var targetGoneLabel: String { targetState == "deleted" ? "Deleted" : "Archived" }
    /// A deleted chat has nothing left to read, so the feed stops asking.
    private var followedChat: String { targetState == "deleted" ? "" : target }

    /// The crown's stops: Main first when it has a chat, then the list.
    var crownChats: [WatchChat] {
        var stops = chats
        if let main = mainChat, main.canPick, let id = main.id { stops.insert(WatchChat(id: id, title: main.title ?? "Main"), at: 0) }
        return stops
    }
    /// Where this chat sits on the crown's stops. A T3 thread or a chat removed on the phone isn't
    /// on them, so the crown leaves it alone.
    var targetIndex: Int? { crownChats.firstIndex { $0.id == target } }
    /// A crossed-out chat isn't a stop either, but a turn moves off it to the top of the list.
    var crownWorks: Bool { targetIndex != nil || (targetGone && !crownChats.isEmpty) }

    /// Choose where notes go. It stays until he picks again.
    func select(id: String, title: String) {
        LocalSettings.targetTitle = title
        defer { if pickingForHeld { pickingForHeld = false; sendHeldToTarget() } }
        guard id != target else { updateWidget(); return }
        LocalSettings.targetState = "ok"
        targetState = "ok"
        target = id
        LocalSettings.target = id
        if mode != nil { announce("recording") }   // move the "Dictating" bar to the new chat
    }

    /// The chosen chat was renamed: the pill keeps showing its real name.
    private func noteRename() {
        guard let name = feed.history?.chat, name != LocalSettings.targetTitle else { return }
        LocalSettings.targetTitle = name
        updateWidget()
    }

    /// Clips a chat couldn't take, and the latest reason why.
    private(set) var heldCount = 0
    private(set) var heldReason: String?
    var showHeld = false
    /// The chat list was opened from the held notes: the chat picked there gets them.
    var pickingForHeld = false
    /// A note was just refused by its chat: show the held notes as soon as he's looking.
    private var heldPrompt = false
    private func updateHeld() {
        let before = heldCount
        heldCount = uploader.held.count
        heldReason = uploader.needsChat.first.flatMap { uploader.held[$0] } ?? uploader.held.values.first
        if queuedCount == 0 { Reminders.shared.nothingStuck() }
        // A chat refusing a note may have just been archived or deleted.
        if heldCount > before { Task { if (try? await API.settings()) != nil { syncChats() } } }
    }
    /// The chat refused the note, so nothing happens to it until he picks another: ask straight
    /// away instead of leaving a line of small text. Never over a recording.
    private func askAboutHeld() {
        guard heldPrompt, active, mode == nil, !showChatPicker, !showHelp else { return }
        heldPrompt = false
        if !uploader.needsChat.isEmpty { showHeld = true }
    }
    func sendHeldToTarget() {
        guard hasTarget else { return }
        showHeld = false
        Task {
            await uploader.sendHeld(to: target)
            queuedCount = uploader.queuedCount
            if queuedCount == 0, case .queued = status { status = .ready }
        }
    }
    /// A chat tapped on the held notes' own list. If the chosen chat is gone, or none is chosen,
    /// this one takes its place; otherwise only the held notes go there.
    func sendHeld(to chat: WatchChat) {
        if !hasTarget || targetGone { select(id: chat.id, title: chat.title) }
        showHeld = false
        Task {
            await uploader.sendHeld(to: chat.id)
            queuedCount = uploader.queuedCount
            if queuedCount == 0, case .queued = status { status = .ready }
        }
    }
    func discardHeld() {
        uploader.discardHeld()
        showHeld = false
        queuedCount = uploader.queuedCount
        if queuedCount == 0, case .queued = status { status = .ready }
    }

    func syncChats() {
        chats = LocalSettings.chats
        mainChat = LocalSettings.mainChat
        target = LocalSettings.target
        targetState = LocalSettings.targetState
        continuous = LocalSettings.continuous
    }

    func setContinuous(_ on: Bool, save: Bool = true) {
        if continuous, !on { event("loop-ended", "turned off"); stopResuming() }
        continuous = on
        LocalSettings.continuous = on
        if save { Task { _ = try? await API.update(["continuous": on]) } }
    }

    /// The big button: start if idle, stop and send if recording.
    func toggle() {
        if mode == nil { startByHand() } else { end(by: .tap) }
    }

    /// A tap on the screen, so he's looking: a chat that's gone opens the list instead of
    /// recording a note that can't be delivered. The Action Button still records (he may not be
    /// looking, and what he says is never dropped); that note is held and asks where to go.
    private func startByHand() {
        if hasTarget, targetGone { showChatPicker = true; return }
        start(.tap)
    }

    /// He ended the note. One that ran long asks first.
    private func end(by: NoteEnd) {
        if !continuous, !autoStarted, Date().timeIntervalSince(recordingStarted) >= Self.longNote {
            guard !askLongNote else { return }
            // The mic stops listening while the question is up: with the Action Button he may not
            // be looking, and nothing more should be recorded until he answers. A buzz says look.
            longNoteSeconds = Date().timeIntervalSince(recordingStarted)
            recorder.pause()
            askLongNote = true
            WKInterfaceDevice.current().play(.retry)
            event("long-note-asked", "\(Int(longNoteSeconds)) s, ended by \(by.rawValue)")
            return
        }
        finish(endedBy: by)
    }

    /// How long the note was when the question came up.
    private(set) var longNoteSeconds: TimeInterval = 0

    func sendLongNote() {
        askLongNote = false
        if mode != nil { finish(endedBy: .tap) }
    }

    func discardLongNote() {
        askLongNote = false
        if mode != nil { cancel() }
    }

    func keepRecording() {
        askLongNote = false
        if mode != nil, !micPaused { recorder.resume() }
    }

    /// From the X's "are you sure": send it after all. In Continuous that also ends the run, as X does.
    func sendInsteadOfDiscard() {
        guard mode != nil else { return }
        if continuous { event("loop-ended", "X, sent") }
        stopResuming()
        finish(endedBy: .tap, endLoop: true)
    }

    var recordedSeconds: TimeInterval { mode == nil ? 0 : Date().timeIntervalSince(recordingStarted) }

    func startTapMode() { start(.tap) }

    /// The chat page's Talk button: back to the mic, recording.
    /// In-app banner, not a system notification. Not on the chat page: the reply lands in view
    /// there. Longer replies stay up a little longer (4 to 8 s). No haptic (failures only).
    private func showBanner(_ item: ChatHistory.Item) {
        guard page == 0 else { return }
        banner = item
        bannerHide?.cancel()
        let seconds = min(4 + Double(item.text.count) / 60, 8)
        bannerHide = Task {
            try? await Task.sleep(for: .seconds(seconds))
            if !Task.isCancelled { banner = nil }
        }
    }

    func dismissBanner() {
        bannerHide?.cancel()
        banner = nil
    }

    /// Tapping the banner opens the chat page at that reply.
    func openBanner() {
        dismissBanner()
        page = 1
    }

    func talkFromChat() {
        page = 0
        if mode == nil { startByHand() }
    }

    func tapToSend() {
        if mode == .tap { end(by: .tap) }
    }

    /// X: discard the current recording (and leave continuous mode's loop).
    func cancel() {
        if continuous { event("loop-ended", "X") }
        event("note-ended", "X, discarded after \(Int(Date().timeIntervalSince(recordingStarted))) s")
        stopResuming()
        announce("idle")
        stopHeartbeat()
        Reminders.shared.recordingEnded()
        askLongNote = false
        autoStarted = false
        recorder.discard()
        mode = nil
        micPaused = false
        status = .ready
        playHeldSpeech()
    }

    private func start(_ newMode: Mode, auto: Bool = false, attempt: Int = 0) {
        guard mode == nil, micAllowed else { return }
        guard hasTarget else { showChatPicker = true; return }   // never pick a chat for him
        cancelHold()
        do {
            try recorder.start()
        } catch {
            // Continuous: the mic can be busy for a moment (a call, Siri), so try again a few
            // times before giving up. Giving up always buzzes: the loop never stops silently.
            if auto, continuous, attempt < Self.restartDelays.count {
                event("restart-failed", "\(error.localizedDescription) (try \(attempt + 1))")
                status = .restarting
                Task {
                    try? await Task.sleep(for: Self.restartDelays[attempt])
                    if continuous, mode == nil { start(newMode, auto: true, attempt: attempt + 1) }
                }
                return
            }
            if auto { event("loop-ended", "mic wouldn't start: \(error.localizedDescription)") }
            status = .failed(auto ? "Continuous stopped: \(error.localizedDescription)" : error.localizedDescription)
            WKInterfaceDevice.current().play(.failure)
            return
        }
        if attempt > 0 { event("restarted", "after \(attempt) tries") }
        began(newMode, auto: auto)
    }

    /// Keep the session on for the next note; let go when the time is up.
    private func holdMic() {
        cancelHold()
        holdTask = Task {
            try? await Task.sleep(for: Self.micHold)
            guard !Task.isCancelled else { return }
            releaseMic()
        }
    }

    private func cancelHold() {
        holdTask?.cancel()
        holdTask = nil
    }

    /// The hold is over early: a call or Siri took the session, or the app left the screen.
    private func endHold() {
        if holdTask != nil { releaseMic() }
    }

    /// Nothing needs the mic: let go of it. A reply playing on the watch shares the session,
    /// and letting go would cut it off, so voice.onFinished comes back here when it ends.
    private func releaseMic(retry: Bool = true) {
        cancelHold()
        guard mode == nil, !voice.usesWatchAudio, let error = recorder.release() else { return }
        event("mic-release-failed", error)
        guard retry else { return }
        Task {
            try? await Task.sleep(for: .seconds(2))
            if holdTask == nil { releaseMic(retry: false) }
        }
    }

    /// The mic is live: everything that goes with a note starting.
    private func began(_ newMode: Mode, auto: Bool) {
        // A note he started means he wants to talk: the reply stops. Only a note Continuous
        // started on its own waits for the reply, so the reply never lands in it.
        if voice.isSpeaking {
            if auto { recorder.pause(); micPaused = true } else { voice.stop() }
        }
        uploader.prewarm()
        recordingStarted = Date()
        mode = newMode
        page = 0   // the Action Button while reading the chat: show the recording
        autoStarted = auto
        stopNote = nil
        readyPulse += 1
        announce("recording")
        startHeartbeat()
        capLength(Self.noteCap)
        // Continuous is meant to keep listening; a single note left running is the accident.
        if !continuous { Reminders.shared.recordingStarted(chat: targetTitle) }
        justStarted = true
        // No haptic here: the waveform and ring burst show the mic is live.
        Task {
            try? await Task.sleep(for: .seconds(1.4))
            justStarted = false
        }
    }

    /// `stopNote`: the note ended on its own (mic cut off, length cap); send what there
    /// is and say why. `endLoop`: don't start the next Continuous note.
    private func finish(endedBy: NoteEnd, stopNote: String? = nil, endLoop: Bool = false) {
        let early = stopNote != nil
        // A tap right after Continuous starts the next note is a late or double tap on the
        // send: ignore it. It used to end the loop, which kept switching Continuous off.
        // X or the loop button ends it.
        if autoStarted, !early, Date().timeIntervalSince(recordingStarted) < Self.stopTapWindow {
            event("tap-ignored", "right after a restart")
            return
        }
        let releasedAt = ContinuousClock.now
        stopHeartbeat()
        Reminders.shared.recordingEnded()
        askLongNote = false
        mode = nil
        micPaused = false
        let wasAuto = autoStarted
        autoStarted = false
        let nextNote = continuous && !endLoop
        // Only after a note you sent yourself, on screen. A note the system cut off, or one ended
        // with the app in the background, gives the mic straight back.
        let hold = LocalSettings.micHold && !nextNote && !early && active
        guard let clip = recorder.stop(keepSession: nextNote || hold) else {
            if !nextNote { recorder.release() }
            announce("idle")
            playHeldSpeech()
            return
        }
        if clip.durationMs < 500 {   // an accidental touch, not a note
            recorder.release()
            try? FileManager.default.removeItem(at: clip.url)
            announce("idle", clipId: clip.id)
            showBriefly(.tooShort)
            event("note-too-short", "\(clip.durationMs) ms, ended by \(endedBy.rawValue), mic paused \(clip.pausedMs) ms")
            if !wasAuto { WKInterfaceDevice.current().play(.retry) }
            playHeldSpeech()
            return
        }
        announce("transcribing", clipId: clip.id)
        if hold { holdMic() }
        // Haptics only on failure: send, success, cancel and chat switches are silent.
        sendPulse += 1
        status = .sending
        sendingSlow = false
        sendRun += 1
        let run = sendRun
        Task {
            try? await Task.sleep(for: .seconds(8))
            if run == sendRun, status == .sending { sendingSlow = true }
        }
        let sendTo = target
        let sendToTitle = targetTitle
        playHeldSpeech()
        updateWidget()
        // Continuous: show "Sent" briefly, then start the next note while this one uploads.
        // The pause makes the hand-off obvious; the ready burst says when to talk.
        self.stopNote = stopNote
        if nextNote {
            sentFlash = true
            Task {
                try? await Task.sleep(for: .milliseconds(550))
                sentFlash = false
                // Turned off in that moment: don't start another note, and let go of the mic.
                guard continuous else { if mode == nil { releaseMic() }; return }
                start(.tap, auto: true)
            }
        }
        Task {
            let outcome = await uploader.send(clip, target: sendTo, auto: wasAuto, endedBy: endedBy, releasedAt: releasedAt)
            if run == sendRun { sendingSlow = false }
            // Asked once, with a note just finished and nothing recording: not over their first words.
            if mode == nil { Reminders.shared.ask() }
            switch outcome {
            case .sent(let text, let ms):
                status = .sent(text: text, ms: ms)
                sentTo = sendToTitle
                LocalSettings.lastNoteAt = Date()
                updateWidget()
                if LocalSettings.replyWatch {
                    LocalSettings.lastReplyClip = clip.id
                    reply = .waiting(chat: sendToTitle)
                    followReply()
                }
                showSentTime = true
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    showSentTime = false
                }
            case .empty:
                showBriefly(.empty)
                if !wasAuto { WKInterfaceDevice.current().play(.retry) }   // Continuous hears plenty of nothing
            case .queued(let reason):
                status = .queued(reason)
                WKInterfaceDevice.current().play(.failure)
                Reminders.shared.noteStuck(count: uploader.queuedCount)
                if uploader.needsChat.contains(clip.id) { heldPrompt = true }
            case .rejected(let reason):
                status = .failed(reason)
                WKInterfaceDevice.current().play(.failure)
            }
            queuedCount = uploader.queuedCount
            askAboutHeld()
            retryWaiting()
        }
    }

    /// Notes waiting on the connection go again by themselves while the app is alive: after this
    /// note's own result (a working send means the link is back), then at these gaps. Before this
    /// they waited for the app to be opened again. A note its chat refused isn't retried: it waits
    /// for him to pick.
    private static let retryGaps: [Duration] = [.seconds(10), .seconds(30), .seconds(60), .seconds(120), .seconds(300)]
    private var retryTask: Task<Void, Never>?
    private func retryWaiting() {
        guard uploader.retryableCount > 0 else { return }
        retryTask?.cancel()
        retryTask = Task {
            if case .sent = status { await flush() }
            for gap in Self.retryGaps {
                guard !Task.isCancelled, uploader.retryableCount > 0 else { return }
                try? await Task.sleep(for: gap)
                guard !Task.isCancelled else { return }
                await flush()
            }
        }
    }

    /// Keeps the status widget (Smart Stack / rectangular face slot) in step: the chat notes
    /// go to and when the last one went.
    func updateWidget() {
        WidgetState.publish(.init(targetTitle: targetGone ? "\(targetTitle) (\(targetGoneLabel.lowercased()))" : targetTitle, isT3: target.isT3Target, lastNote: LocalSettings.lastNoteAt))
    }

    /// Asks the server for the chat's answer to the last note every 2 s while the app is on
    /// screen, for up to 20 minutes; a push carries the answer when the watch is down.
    func followReply() {
        guard let clip = LocalSettings.lastReplyClip else { return }
        replyPoll?.cancel()
        replyPoll = Task {
            for _ in 0..<600 {
                if Task.isCancelled { return }
                if let r = try? await API.reply(clip: clip), clip == LocalSettings.lastReplyClip {
                    switch r.status {
                    case "done": reply = .done(text: r.text ?? "", chat: r.chat); speak(clip, r.audioSec); return
                    case "waiting": reply = .waiting(chat: r.chat)
                    default: reply = nil; return
                    }
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// The chat changed (the feed saw it): a reply we're waiting for may have just finished.
    /// The server stores it on the same event, so give it a moment, then ask once.
    private func checkReplyNow() {
        guard case .waiting? = reply, let clip = LocalSettings.lastReplyClip else { return }
        Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard let r = try? await API.reply(clip: clip), clip == LocalSettings.lastReplyClip,
                  case .waiting? = reply, r.status == "done" else { return }
            replyPoll?.cancel()
            reply = .done(text: r.text ?? "", chat: r.chat)
            speak(clip, r.audioSec)
        }
    }

    /// Read the reply aloud (setting on the iPhone app). During a note it waits until the note is
    /// sent: pausing the mic there cut off whatever he said next, with nothing on screen to say so.
    /// Continuous is always listening, so there the mic pauses instead (the status line says so).
    private func speak(_ clip: String, _ seconds: Double?) {
        guard let seconds, seconds > 0, LocalSettings.speak != .off, spokenClip != clip else { return }
        spokenClip = clip
        if mode != nil, !continuous {
            heldSpeech = (clip, seconds)
            return
        }
        if mode != nil { recorder.pause(); micPaused = true }
        voice.speak(clip: clip, seconds: seconds, via: LocalSettings.speak)
    }

    /// The note is over: read the reply that waited for it.
    private func playHeldSpeech() {
        guard mode == nil, let held = heldSpeech else { return }
        heldSpeech = nil
        voice.speak(clip: held.clip, seconds: held.seconds, via: LocalSettings.speak)
    }

    /// "Dictating on watch" in the target chat: recording, then transcribing, or idle.
    private func announce(_ state: String, clipId: String? = nil) {
        uploader.reportStatus(state, clipId: clipId ?? recorder.clipId, target: target, startedAt: recordingStarted)
    }

    /// The chat's bar hides itself if these stop, e.g. when the watch loses signal.
    private func startHeartbeat() {
        heartbeat?.cancel()
        heartbeat = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                if Task.isCancelled || mode == nil { return }
                announce("recording")
            }
        }
    }

    private func stopHeartbeat() {
        heartbeat?.cancel()
        heartbeat = nil
        lengthCap?.cancel()
        lengthCap = nil
    }

    private func capLength(_ cap: Duration) {
        lengthCap = Task {
            try? await Task.sleep(for: cap)
            guard !Task.isCancelled, mode != nil else { return }
            finish(endedBy: .lengthCap, stopNote: continuous ? "Sent at 8 hours (the upload limit), still listening"
                                        : "Stopped at 8 hours (the upload limit), sent it")
        }
    }

    /// The system stopped the mic mid-note. Send what was recorded.
    private func cutOff() {
        guard mode != nil else { return }
        guard continuous else {
            event("mic-cut-off")
            finish(endedBy: .cutOff, stopNote: "Mic stopped early, sent what it heard", endLoop: true)
            return
        }
        // A call or alert took the mic: send what was heard, let go of the mic, and pick up
        // again when it's over (the system says so, or the next try works).
        event("mic-cut-off", "paused, resumes after")
        finish(endedBy: .cutOff, stopNote: "Paused for a call or alert, resumes after", endLoop: true)
        pauseLoop(nil)
    }

    /// Continuous is waiting to get the mic back. Tries every 15 s for 10 minutes (a call can
    /// run long), then buzzes: it never stops for good without saying so.
    private var resumeAfterInterruption = false
    private var resumeTask: Task<Void, Never>?

    private func pauseLoop(_ reason: String?) {
        if let reason { event("paused", reason) }
        resumeAfterInterruption = true
        resumeTask?.cancel()
        resumeTask = Task {
            for _ in 0..<40 {
                try? await Task.sleep(for: .seconds(15))
                if Task.isCancelled || !resumeAfterInterruption { return }
                if tryResume() { return }
            }
            guard !Task.isCancelled, resumeAfterInterruption else { return }
            resumeAfterInterruption = false
            event("loop-ended", "mic unavailable for 10 minutes")
            status = .failed("Continuous stopped: the mic stayed busy")
            WKInterfaceDevice.current().play(.failure)
        }
    }

    /// Back on the mic after a call or alert. False if it's still busy.
    @discardableResult
    func tryResume() -> Bool {
        guard resumeAfterInterruption, continuous, mode == nil, micAllowed else { return false }
        cancelHold()
        do { try recorder.start() } catch { return false }
        resumeAfterInterruption = false
        resumeTask?.cancel()
        event("resumed")
        began(.tap, auto: true)
        return true
    }

    private func stopResuming() {
        resumeAfterInterruption = false
        resumeTask?.cancel()
    }

    /// Continuous: waits before each retry when the mic won't start.
    private static let restartDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(15)]

    /// A line in the server log, so a loop that stopped can be traced afterwards.
    private func event(_ name: String, _ detail: String = "") {
        uploader.reportEvent(name, detail: detail)
    }

    func level() -> Double { mode == nil ? 0 : recorder.level() }

    /// "Didn't catch anything" and "Too short, not sent" say nothing is waiting, so after a few
    /// seconds the screen goes back to "Tap to talk". Failures and the sent note's text stay.
    private var briefStatus = 0
    private func showBriefly(_ s: Status) {
        status = s
        briefStatus += 1
        let mine = briefStatus
        Task {
            try? await Task.sleep(for: .seconds(4))
            if mine == briefStatus, status == s { status = .ready }
        }
    }

    func checkServer() async -> Bool { await uploader.health() }

    private func flush() async {
        await uploader.flush()
        queuedCount = uploader.queuedCount
        if queuedCount == 0, case .queued = status { status = .ready }
    }
}
