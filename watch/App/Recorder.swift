import AVFoundation

/// One finished recording, named by the id the server dedupes on.
struct Clip {
    let id: String
    let url: URL
    let durationMs: Int
    /// How long the mic sat paused in this note (a reply read aloud in Continuous).
    var pausedMs = 0
}

/// AAC, 16 kHz mono: what the server's speech model wants, and small to upload
/// (about 4 KB per second).
final class Recorder {
    private var recorder: AVAudioRecorder?
    private(set) var clipId = ""
    /// Called on the main thread when the system cuts the mic off mid-note (a call,
    /// Siri, or watchOS suspending the app). What was recorded so far is still on disk.
    var onCutOff: (() -> Void)?
    /// Called when the call or alert that cut the mic off is over.
    var onInterruptionEnded: (() -> Void)?
    /// Called when a call or alert takes the audio session, recording or not.
    var onInterruptionBegan: (() -> Void)?
    private let watcher = CutOffWatcher()
    private var pausedSince: ContinuousClock.Instant?
    private var pausedMs = 0
    /// The mic is off for now, in the middle of a note.
    var isPaused: Bool { pausedSince != nil }

    init() {
        watcher.fire = { [weak self] stopped in
            guard let self, let current = self.recorder, stopped == nil || stopped === current else { return }
            self.onCutOff?()
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil,
                                               queue: .main) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
                .flatMap(AVAudioSession.InterruptionType.init)
            if type == .began {
                self?.watcher.fire?(nil)
                self?.onInterruptionBegan?()
            }
            if type == .ended { self?.onInterruptionEnded?() }
        }
    }

    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    /// Setting the category early takes it off the press-to-record path.
    /// Mixable, so alert sounds and calls aren't silenced while Continuous holds the mic (a
    /// record-only session takes audio for itself). Calls still interrupt it; Continuous
    /// pauses and resumes after.
    static let category = AVAudioSession.Category.playAndRecord
    static let options: AVAudioSession.CategoryOptions = [.mixWithOthers]

    func prepare() {
        try? AVAudioSession.sharedInstance().setCategory(Self.category, mode: .default, options: Self.options)
    }

    /// Always activates, even when the session should already be on: a call or Siri may have
    /// ended it without us seeing it, and activating an active session costs little. A failed
    /// start lets go of the mic, so it can't leave the orange dot on.
    func start() throws {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(Self.category, mode: .default, options: Self.options)
            try session.setActive(true)
            clipId = UUID().uuidString.lowercased()
            let url = FileManager.default.temporaryDirectory.appending(path: "\(clipId).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let r = try AVAudioRecorder(url: url, settings: settings)
            r.isMeteringEnabled = true
            r.delegate = watcher
            guard r.record() else { throw RecorderError.couldNotStart }
            recorder = r
            pausedSince = nil
            pausedMs = 0
        } catch {
            release()
            throw error
        }
    }

    var isRecording: Bool { recorder?.isRecording ?? false }

    /// Voice level 0...1 for the on-screen meter.
    /// Stop listening for a moment (a reply is being read aloud) without ending the note.
    func pause() {
        guard let r = recorder, pausedSince == nil else { return }
        r.pause()
        pausedSince = .now
    }
    func resume() {
        guard let r = recorder, let since = pausedSince else { return }
        r.record()
        pausedMs += milliseconds(since: since)
        pausedSince = nil
    }

    func level() -> Double {
        guard let r = recorder else { return 0 }
        r.updateMeters()
        let db = Double(r.averagePower(forChannel: 0))   // about -60 (quiet) to 0 (loud)
        return min(1, max(0, (db + 50) / 45))
    }

    /// `keepSession`: the next note starts right away (Continuous). Keeping the audio
    /// session active lets it start with the screen off, where reactivating can fail.
    func stop(keepSession: Bool = false) -> Clip? {
        guard let r = recorder else { return nil }
        var ms = Int(r.currentTime * 1000)   // read before stop() resets it
        if let since = pausedSince { pausedMs += milliseconds(since: since); pausedSince = nil }
        recorder = nil   // first, so the delegate's finish callback below is ignored
        r.stop()
        if !keepSession { release() }
        if ms == 0, let file = try? AVAudioFile(forReading: r.url), file.fileFormat.sampleRate > 0 {
            // The system already stopped it (cut off), so currentTime is gone; ask the file.
            ms = Int(Double(file.length) / file.fileFormat.sampleRate * 1000)
        }
        return Clip(id: clipId, url: r.url, durationMs: ms, pausedMs: pausedMs)
    }

    /// Gives the mic back (the orange dot goes away). Returns the error if the system refused.
    @discardableResult
    func release() -> String? {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func discard() {
        if let clip = stop() { try? FileManager.default.removeItem(at: clip.url) } else { release() }
    }
}

/// AVAudioRecorder reports the system stopping it through its delegate.
private final class CutOffWatcher: NSObject, AVAudioRecorderDelegate {
    var fire: ((AVAudioRecorder?) -> Void)?
    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        DispatchQueue.main.async { self.fire?(recorder) }
    }
    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        DispatchQueue.main.async { self.fire?(recorder) }
    }
}

enum RecorderError: LocalizedError {
    case couldNotStart
    var errorDescription: String? { "Couldn't start the microphone" }
}
