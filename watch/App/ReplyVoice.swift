import AVFoundation
import WatchConnectivity

/// Reads a reply aloud. With "On the iPhone" it asks the iPhone app to play it, so it comes out
/// of whatever the phone is connected to (the car over Bluetooth); if the phone can't be
/// reached, or with "On the watch", it plays on the watch. `onFinished` fires once when it's
/// over, so Continuous can turn the mic back on.
@MainActor
final class ReplyVoice: NSObject, WCSessionDelegate, AVAudioPlayerDelegate {
    var onFinished: (() -> Void)?
    private(set) var isSpeaking = false
    /// The reply is playing (or about to) on this watch, so it needs the audio session.
    var usesWatchAudio: Bool { isSpeaking && phoneClip == nil }
    private var player: AVAudioPlayer?
    private var phoneClip: String?          // the clip the iPhone is playing
    private var timeout: Task<Void, Never>?
    private var playRun = 0                 // a stop or a newer reply outdates a download under way

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func speak(clip: String, seconds: Double, via: Speak) {
        guard via != .off else { return }
        isSpeaking = true
        playRun += 1
        let session = WCSession.default
        if via == .phone, WCSession.isSupported(), session.activationState == .activated, session.isReachable {
            phoneClip = clip
            session.sendMessage(["play": clip], replyHandler: nil) { _ in
                Task { @MainActor in self.playHere(clip, seconds) }   // the phone didn't take it
            }
            endAfter(seconds + 10)   // download and start on the phone, then the reply itself
        } else {
            playHere(clip, seconds)
        }
    }

    private func playHere(_ clip: String, _ seconds: Double) {
        phoneClip = nil
        endAfter(seconds + 15)
        let run = playRun
        Task {
            let data = try? await API.speech(clip: clip)
            guard run == playRun, isSpeaking else { return }
            guard let data, let p = try? AVAudioPlayer(data: data) else { end(); return }
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(Recorder.category, mode: .default, options: Recorder.options)
            try? session.setActive(true)
            player = p
            p.delegate = self
            p.play()
            endAfter(seconds + 3)
        }
    }

    /// A note is starting: the user wants to talk, not listen. No onFinished: the mic is already theirs.
    func stop() {
        guard isSpeaking else { return }
        if let phoneClip, WCSession.default.isReachable {
            WCSession.default.sendMessage(["stop": phoneClip], replyHandler: nil, errorHandler: nil)
        }
        playRun += 1
        isSpeaking = false
        timeout?.cancel()
        phoneClip = nil
        player?.stop()
        player = nil
    }

    private func endAfter(_ seconds: Double) {
        timeout?.cancel()
        timeout = Task {
            try? await Task.sleep(for: .seconds(seconds))
            if !Task.isCancelled { end() }
        }
    }

    private func end() {
        guard isSpeaking else { return }
        isSpeaking = false
        timeout?.cancel()
        phoneClip = nil
        player = nil
        onFinished?()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.end() }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let clip = message["done"] as? String else { return }
        Task { @MainActor in if self.phoneClip == clip { self.end() } }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {}
}
