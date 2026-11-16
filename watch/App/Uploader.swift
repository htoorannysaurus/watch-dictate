import Foundation
import WatchConnectivity

/// Posts clips to the home-server receiver. Every clip is moved into an outbox
/// before upload and deleted only after the server confirms it posted the message,
/// so a dead connection or a killed app never loses a note. The server dedupes on
/// the clip id, so retrying is always safe.
@MainActor
final class Uploader {
    enum Outcome {
        case sent(text: String, ms: Int)
        case empty
        case queued(String)
        case rejected(String)
    }

    private struct Reply: Decodable {
        let ok: Bool?
        let empty: Bool?
        let text: String?
        let accepted: Bool?   // long note: the server took it and is still transcribing
        let error: String?
    }

    private enum Failure: Error {
        case retry(String)      // network or server trouble: keep the clip
        case rejected(String)   // the server will never accept it: drop the clip
        /// This chat can't take it now: keep it, the others still go. `choose`: the chat itself
        /// refused it (gone, archived, none picked), so only the user picking another chat moves it.
        case held(String, choose: Bool)
    }

    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300   // long notes on the local engine take minutes
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()
    private let outbox: URL
    private var inFlight = Set<String>()

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        outbox = support.appending(path: "outbox", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
    }

    var queuedCount: Int { queuedFiles().count }

    /// Opens DNS + TLS while the user is still talking, so the upload reuses it.
    func prewarm() {
        var request = URLRequest(url: Config.base.appending(path: "health"))
        request.timeoutInterval = 5
        Config.authorize(&request)
        session.dataTask(with: request).resume()
    }

    func health() async -> Bool {
        var request = URLRequest(url: Config.base.appending(path: "health"))
        request.timeoutInterval = 8
        Config.authorize(&request)
        guard let (_, response) = try? await session.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    func send(_ clip: Clip, target: String, auto: Bool = false, endedBy: NoteEnd, releasedAt: ContinuousClock.Instant) async -> Outcome {
        let file = outbox.appending(path: "\(clip.id).m4a")
        do {
            try FileManager.default.moveItem(at: clip.url, to: file)
            try? target.write(to: targetFile(clip.id), atomically: true, encoding: .utf8)
            try? (auto ? "1" : "0").write(to: autoFile(clip.id), atomically: true, encoding: .utf8)
            try? "\(endedBy.rawValue) \(clip.pausedMs)".write(to: endFile(clip.id), atomically: true, encoding: .utf8)
        } catch {
            return .queued("Couldn't save the clip")
        }
        let started = ContinuousClock.now
        do {
            let metrics = UploadMetrics()
            let reply = try await post(file: file, clipId: clip.id, durationMs: clip.durationMs, target: target, auto: auto, end: "\(endedBy.rawValue) \(clip.pausedMs)", metrics: metrics)
            let ms = milliseconds(since: releasedAt)
            let fields: [String: Any] = [
                "clipId": clip.id, "releaseToAckMs": ms, "requestMs": milliseconds(since: started),
                "bytes": fileSize(file), "recordMs": clip.durationMs,
                "phoneReachable": WCSession.isSupported() && WCSession.default.isReachable,
            ]
            Task {
                // The system delivers the metrics just after the response.
                try? await Task.sleep(for: .milliseconds(500))
                reportTiming(fields.merging(metrics.fields) { _, new in new })
            }
            remove(clip.id)
            if reply.accepted == true { return .sent(text: "Long note, transcribing. It'll appear in the chat.", ms: ms) }
            return reply.empty == true ? .empty : .sent(text: reply.text ?? "", ms: ms)
        } catch Failure.rejected(let reason) {
            remove(clip.id)
            return .rejected(reason)
        } catch Failure.retry(let reason) {
            return .queued(reason)
        } catch Failure.held(let reason, let choose) {
            hold(clip.id, reason, choose: choose)
            return .queued(reason)
        } catch {
            return .queued(error.localizedDescription)
        }
    }

    /// Why the server wouldn't take each clip it answered about. Held until it does, or until
    /// the user sends them to another chat.
    private(set) var held: [String: String] = [:]
    /// The held clips whose chat refused them: they wait for the user to pick a chat. The rest of
    /// `held` (a server error, a refused key) go again on their own with the next retry.
    private(set) var needsChat = Set<String>()

    private func hold(_ id: String, _ reason: String, choose: Bool) {
        held[id] = reason
        if choose { needsChat.insert(id) } else { needsChat.remove(id) }
    }

    /// Clips waiting on the connection or the server, not on the user: these retry by themselves.
    var retryableCount: Int { queuedFiles().filter { !needsChat.contains($0.deletingPathExtension().lastPathComponent) }.count }

    /// Retries queued clips, oldest first. No connection (offline, timed out, ...) stops the round. A chat that can't take
    /// a note holds only that clip: the others still go, and it's never sent anywhere else.
    func flush() async {
        for file in queuedFiles() {
            let id = file.deletingPathExtension().lastPathComponent
            guard var target = try? String(contentsOf: targetFile(id), encoding: .utf8), !target.isEmpty else {
                hold(id, "Pick a chat for this note", choose: true)
                continue
            }
            if let moved = LocalSettings.legacyTargets[target] {   // queued by a build before 1.0.42
                target = moved.id
                try? target.write(to: targetFile(id), atomically: true, encoding: .utf8)
            }
            do {
                // A retried Continuous note must keep its room-audio note. No file: queued by an older build.
                let auto = try? String(contentsOf: autoFile(id), encoding: .utf8)
                let end = try? String(contentsOf: endFile(id), encoding: .utf8)
                _ = try await post(file: file, clipId: id, durationMs: nil, target: target, retryAuto: auto, end: end)
                remove(id)
            } catch Failure.rejected {
                remove(id)
            } catch Failure.held(let reason, let choose) {
                hold(id, reason, choose: choose)
            } catch {
                return
            }
        }
    }

    /// the user's choice for the held clips: send them to this chat instead. When a chat refused some,
    /// only those move; a clip held for a server error keeps its own chat and just goes again.
    func sendHeld(to target: String) async {
        let moving = needsChat.isEmpty ? Set(held.keys) : needsChat
        for id in moving { try? target.write(to: targetFile(id), atomically: true, encoding: .utf8) }
        held = [:]
        needsChat = []
        await flush()
    }

    func discardHeld() {
        for id in held.keys { remove(id) }
    }

    private func targetFile(_ id: String) -> URL { outbox.appending(path: "\(id).target") }
    private func autoFile(_ id: String) -> URL { outbox.appending(path: "\(id).auto") }
    private func endFile(_ id: String) -> URL { outbox.appending(path: "\(id).end") }
    private func triesFile(_ id: String) -> URL { outbox.appending(path: "\(id).tries") }

    /// This upload's try number for the clip, kept beside it so it survives a restart.
    private func nextTry(_ id: String) -> Int {
        let n = (Int((try? String(contentsOf: triesFile(id), encoding: .utf8)) ?? "") ?? 0) + 1
        try? String(n).write(to: triesFile(id), atomically: true, encoding: .utf8)
        return n
    }

    private func remove(_ id: String) {
        try? FileManager.default.removeItem(at: outbox.appending(path: "\(id).m4a"))
        try? FileManager.default.removeItem(at: targetFile(id))
        try? FileManager.default.removeItem(at: autoFile(id))
        try? FileManager.default.removeItem(at: endFile(id))
        try? FileManager.default.removeItem(at: triesFile(id))
        held[id] = nil
        needsChat.remove(id)
    }

    private func post(file: URL, clipId: String, durationMs: Int?, target: String, auto: Bool = false,
                      retryAuto: String? = nil, end: String? = nil, metrics: UploadMetrics? = nil) async throws -> Reply {
        guard !inFlight.contains(clipId) else { throw Failure.retry("Already sending") }
        inFlight.insert(clipId)
        defer { inFlight.remove(clipId) }

        // Keep the process alive if the wrist drops mid-upload.
        let grace = DispatchSemaphore(value: 0)
        ProcessInfo.processInfo.performExpiringActivity(withReason: "Sending dictation") { expired in
            if !expired { _ = grace.wait(timeout: .now() + 900) }   // big notes take a while to upload
        }
        defer { grace.signal() }

        let tries = nextTry(clipId)
        let started = Date(), appAtStart = NetLog.appState
        let metrics = metrics ?? UploadMetrics()
        func logFailure(error: Error? = nil, status: Int? = nil) {
            NetLog.shared.record(route: "dictate", error: error, status: status, clipId: clipId, attempt: tries,
                                 started: started, appAtStart: appAtStart, metrics: metrics)
        }

        var request = URLRequest(url: Config.base.appending(path: "dictate"))
        request.httpMethod = "POST"
        Config.authorize(&request)
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        request.setValue(clipId, forHTTPHeaderField: "X-Clip-Id")
        request.setValue(LocalSettings.engine.rawValue, forHTTPHeaderField: "X-Engine")
        request.setValue(target, forHTTPHeaderField: "X-Target")
        if auto { request.setValue("1", forHTTPHeaderField: "X-Auto") }   // Continuous started it
        if let retryAuto { request.setValue(retryAuto, forHTTPHeaderField: "X-Auto") }   // "1" or "0"
        if let durationMs { request.setValue(String(durationMs), forHTTPHeaderField: "X-Duration-Ms") }
        // "<why it ended> <ms the mic sat paused>", for the log.
        if let parts = end?.split(separator: " "), parts.count == 2 {
            request.setValue(String(parts[0]), forHTTPHeaderField: "X-Ended-By")
            request.setValue(String(parts[1]), forHTTPHeaderField: "X-Paused-Ms")
        }

        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.upload(for: request, fromFile: file, delegate: metrics)
        } catch {
            // Every failure here counts, a cancel too: nothing in the app cancels an upload.
            logFailure(error: error)
            throw Failure.retry(NetLog.reason(error))   // "Offline", "Timed out", ... or "No connection"
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        let reply = try? JSONDecoder().decode(Reply.self, from: data)
        // A refusal from the app itself (no audio, chat gone) is in the server's own log. Anything else
        // (Cloudflare's 5xx, a refused key) may never have reached it.
        if !(200..<300).contains(status), status != 400, status != 409 { logFailure(status: status) }
        switch status {
        case 200..<300:
            NetLog.shared.deliver()
            return reply ?? Reply(ok: true, empty: nil, text: nil, accepted: nil, error: nil)
        case 400:
            // Only a clip the server can never use (no audio in it) is dropped. A refused key (401)
            // or a size limit (413) keeps the note: those are fixed on the server or by an update,
            // and a note must never be deleted for them.
            throw Failure.rejected(reply?.error ?? "Rejected (\(status))")
        case 401:
            throw Failure.held("The server refused this app's key. Notes are kept", choose: false)
        case 413:
            throw Failure.held("Too big for the server. The note is kept", choose: false)
        default:
            throw Failure.held(reply?.error ?? "Server error \(status)", choose: status == 409)
        }
    }

    /// Tells the server what the mic is doing so the chat can show "Dictating on watch".
    /// Fire and forget: a lost ping only means the bar shows late or expires early.
    func reportEvent(_ name: String, detail: String) {
        guard let body = try? JSONSerialization.data(withJSONObject: ["event": name, "detail": detail]) else { return }
        var request = URLRequest(url: Config.base.appending(path: "event"))
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        Config.authorize(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        session.dataTask(with: request).resume()
    }

    func reportStatus(_ state: String, clipId: String, target: String, startedAt: Date) {
        let fields: [String: Any] = ["state": state, "clipId": clipId, "target": target,
                                     "startedAt": Int64(startedAt.timeIntervalSince1970 * 1000)]   // Int is 32-bit on the watch
        guard let body = try? JSONSerialization.data(withJSONObject: fields) else { return }
        var request = URLRequest(url: Config.base.appending(path: "status"))
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        Config.authorize(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        session.dataTask(with: request).resume()
    }

    func reportTiming(_ fields: [String: Any]) {
        guard let body = try? JSONSerialization.data(withJSONObject: fields) else { return }
        var request = URLRequest(url: Config.base.appending(path: "timing"))
        request.httpMethod = "POST"
        Config.authorize(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        session.dataTask(with: request).resume()
    }

    private func queuedFiles() -> [URL] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: outbox, includingPropertiesForKeys: [.creationDateKey])) ?? []
        return files
            .filter { $0.pathExtension == "m4a" && !inFlight.contains($0.deletingPathExtension().lastPathComponent) }
            .sorted { creation($0) < creation($1) }
    }

    private func creation(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
    }

    private func fileSize(_ url: URL) -> Int {
        (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    }
}

func milliseconds(since start: ContinuousClock.Instant) -> Int {
    let d = ContinuousClock.now - start
    return Int(d.components.seconds * 1000 + d.components.attoseconds / 1_000_000_000_000_000)
}
