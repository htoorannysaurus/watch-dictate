import Foundation

/// The receiver on the home server, through the Cloudflare tunnel. Cloudflare Access
/// lets only requests carrying the service token through; the server then checks the
/// bearer token. Both are generated into Secrets.swift (gitignored) by sync-to-mac.sh
/// from ~/.config/watch-dictate/ on the home server.
enum Config {
    static let base: URL = {
        #if DEBUG
        // Simulator tests: `-debugServer http://127.0.0.1:9999` keeps test clips off the real chats.
        if let s = UserDefaults.standard.string(forKey: "debugServer"), let url = URL(string: s) { return url }
        #endif
        return URL(string: "https://dictate.example.com")!
    }()

    static func authorize(_ request: inout URLRequest) {
        request.setValue(Secrets.accessClientId, forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(Secrets.accessClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        request.setValue("Bearer \(Secrets.token)", forHTTPHeaderField: "Authorization")
        request.setValue(AppVersion.text, forHTTPHeaderField: "X-App-Version")
        #if os(watchOS)
        request.setValue("watchOS", forHTTPHeaderField: "X-App-Platform")
        #else
        request.setValue("iOS", forHTTPHeaderField: "X-App-Platform")
        #endif
    }
}

/// "1.0.20 (2610261052)": marketing version and build number, shown in Settings on both apps.
enum AppVersion {
    static let text: String = {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }()
}

/// The app version the server last saw from a device, and when.
struct SeenVersion: Codable { let version: String; let at: String }

/// Speech-to-text choice, sent with each clip; also stored on the server so phone and watch agree.
enum Engine: String, CaseIterable, Identifiable, Codable {
    case local, deepgram
    var id: String { rawValue }
    var label: String { self == .local ? "On my server" : "Cloud (Deepgram)" }
    var detail: String {
        self == .local ? "Private: audio stays on your home server. Slower on long notes."
                       : "Faster, about 1 s even for long notes. Audio leaves your home server."
    }
}

/// A chat the watch can send to: a Claudeputer session id, or "t3:<thread id>" for a T3 thread.
struct WatchChat: Codable, Equatable, Identifiable { let id: String; let title: String }

/// Claudeputer's Main chat, for the Main row. `state`: "ok", "archived", or "none" when no Main is set.
struct MainChat: Codable, Equatable {
    let id: String?
    let title: String?
    let state: String
    var canPick: Bool { state == "ok" && id != nil }
}

/// What the server says about the chat this device has selected: "ok", "archived" or "deleted".
struct SelectedChat: Codable, Equatable { let id: String; let title: String?; let state: String }

/// A T3 Code thread notes can go to. The server's list changes as threads settle or snooze.
struct T3Thread: Codable, Equatable, Identifiable, Hashable {
    let id: String   // "t3:<thread id>"
    let title: String
    let project: String?
    let running: Bool
    let flag: String?   // "settled", "snoozed", "archived": only the chosen thread can have one
}
struct T3Threads: Codable { let threads: [T3Thread]; let stale: Bool }

extension String {
    /// A target that is a T3 thread (purple), not a Claudeputer chat.
    var isT3Target: Bool { self == "t3" || hasPrefix("t3:") }
}

/// How the server marks a posted note as watch speech-to-text.
enum NoteTag: String, Codable, CaseIterable, Identifiable {
    case off, simple, detailed
    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: "None"
        case .simple: "⌚ only"
        case .detailed: "⌚ with length and mode"
        }
    }
    var example: String {
        switch self {
        case .off: "Picked up milk."
        case .simple: "⌚ Picked up milk."
        case .detailed: "[⌚ 0:12 · continuous] Picked up milk."
        }
    }
}

/// What a note does when the chat is running a turn.
enum MidTurn: String, Codable, CaseIterable, Identifiable {
    case steer, queue
    var id: String { rawValue }
    var label: String { self == .steer ? "Steer" : "Queue" }
}

struct ServerSettings: Codable {
    var engine: Engine
    var autoStart: Bool
    var extras: [String]
    var continuous: Bool?
    var micHold: Bool?
    var tag: NoteTag?
    var replyWatch: Bool?
    var replyPush: Bool?
    var speak: Speak?
    var midTurn: MidTurn?
    var voice: Voice?
    var destinations: [WatchChat]?
    /// Missing: the server couldn't tell just now, so the last known stays.
    var main: MainChat?
    var selected: SelectedChat?
    var t3Enabled: Bool?
    /// What an older build's stored target ("main", "t3") means now. Missing key: can't be resolved.
    var legacyTargets: [String: WatchChat]?
    var versions: [String: SeenVersion]?
    var server: String?
}

struct Chat: Codable, Identifiable { let id: String; let title: String; let host: String?; let active: Bool }
struct DictionaryEntry: Codable, Hashable { let word: String; let replacement: String? }

struct ChatReply: Codable { let status: String; let text: String?; let chat: String?; let audioSec: Double? }

/// Where replies are read aloud: the iPhone (so it reaches the car over Bluetooth), the watch
/// speaker, or not at all.
enum Speak: String, Codable, CaseIterable, Identifiable {
    case off, phone, watch
    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: "Off"
        case .phone: "On the iPhone (car)"
        case .watch: "On the watch"
        }
    }
}

/// Who reads replies aloud. ElevenLabs sounds better but its free tier covers about ten
/// replies a month; past that the server falls back to Deepgram.
enum Voice: String, Codable, CaseIterable, Identifiable {
    case deepgram, elevenlabs
    var id: String { rawValue }
    var label: String {
        switch self {
        case .deepgram: "Deepgram"
        case .elevenlabs: "ElevenLabs"
        }
    }
}

/// The watch's chat page: the last messages of the chat notes go to, oldest first (GET /history).
/// `working` is set while the agent's turn is still running, with its latest line.
struct ChatHistory: Codable, Equatable {
    struct Item: Codable, Equatable, Identifiable {
        let id: String
        let role: String      // "me" or "agent"
        let text: String
        let at: Double?       // ms since 1970
        let watch: Bool?
        var isMe: Bool { role == "me" }
        var date: Date? { at.map { Date(timeIntervalSince1970: $0 / 1000) } }
    }
    struct Working: Codable, Equatable { let line: String? }
    let chat: String
    let version: String
    let items: [Item]
    let working: Working?
    let flag: String?   // a T3 thread that is settled, snoozed or archived
}

struct Dictation: Codable, Identifiable {
    let id: String
    let at: String
    let seconds: Double?
    let engine: String?
    let chat: String?
    let targetKind: String?
    let text: String
    let heard: String?
    let reply: String?
    let status: String
    let sendMs: Int?
    let error: String?
}

struct Recent: Codable { let dictations: [Dictation] }

/// Last-known settings on this device, so launch never waits on the network.
enum LocalSettings {
    static var engine: Engine {
        get { Engine(rawValue: UserDefaults.standard.string(forKey: "engine") ?? "") ?? .deepgram }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "engine") }
    }
    static var autoStart: Bool {
        get { UserDefaults.standard.object(forKey: "autoStart") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "autoStart") }
    }
    /// Turning the crown switches chats (behind a big dead zone). Watch only, on by default.
    static var crownSwitch: Bool {
        get { UserDefaults.standard.object(forKey: "crownSwitch") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "crownSwitch") }
    }
    static var continuous: Bool {
        get { UserDefaults.standard.bool(forKey: "continuous") }
        set { UserDefaults.standard.set(newValue, forKey: "continuous") }
    }
    /// Keep the audio session on for 30 s after a single note, so the next one starts faster.
    /// Set only in the server's settings.json; off unless it says true.
    static var micHold: Bool {
        get { UserDefaults.standard.bool(forKey: "micHold") }
        set { UserDefaults.standard.set(newValue, forKey: "micHold") }
    }
    /// The Claudeputer chats on the watch's list, all alike. Rows an older build cached are dropped.
    static var chats: [WatchChat] {
        get {
            guard let data = UserDefaults.standard.data(forKey: "chats"),
                  let list = try? JSONDecoder().decode([WatchChat].self, from: data) else { return [] }
            return list.filter { $0.id != "main" && !$0.id.isT3Target }
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: "chats") }
    }
    /// The Main row's last known chat. Nil until the server has answered once.
    static var mainChat: MainChat? {
        get { UserDefaults.standard.data(forKey: "mainChat").flatMap { try? JSONDecoder().decode(MainChat.self, from: $0) } }
        set { UserDefaults.standard.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "mainChat") }
    }
    /// The selected chat's last known state: "ok", "archived" or "deleted".
    static var targetState: String {
        get { UserDefaults.standard.string(forKey: "targetState") ?? "ok" }
        set { UserDefaults.standard.set(newValue, forKey: "targetState") }
    }
    /// T3 threads can be chosen (the server has T3 turned on).
    static var t3Enabled: Bool {
        get { UserDefaults.standard.bool(forKey: "t3Enabled") }
        set { UserDefaults.standard.set(newValue, forKey: "t3Enabled") }
    }
    /// What older targets on queued clips mean now.
    static var legacyTargets: [String: WatchChat] {
        get { UserDefaults.standard.data(forKey: "legacyTargets").flatMap { try? JSONDecoder().decode([String: WatchChat].self, from: $0) } ?? [:] }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: "legacyTargets") }
    }
    /// An install from before 1.0.42 that never switched chats has no stored target: it meant
    /// "main". Noted once, before the new chat list replaces the old one, along with its name.
    private static let upgraded: Void = {
        let d = UserDefaults.standard
        guard !d.bool(forKey: "targetUpgraded") else { return }
        d.set(true, forKey: "targetUpgraded")
        guard let data = d.data(forKey: "chats"), let old = try? JSONDecoder().decode([WatchChat].self, from: data) else { return }
        let target = d.string(forKey: "target") ?? "main"
        d.set(target, forKey: "target")
        d.set(old.first { $0.id == target }?.title, forKey: "targetTitle")
    }()
    /// The name of the chosen chat, for the pill. It can be off the lists by now.
    static var targetTitle: String? {
        get { _ = upgraded; return UserDefaults.standard.string(forKey: "targetTitle") }
        set { UserDefaults.standard.set(newValue, forKey: "targetTitle") }
    }
    /// The chat the watch sends to: whichever was last picked, across launches. Empty: none yet.
    static var target: String {
        get { _ = upgraded; return UserDefaults.standard.string(forKey: "target") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "target") }
    }
    /// Show the chat's answer to each note on the watch (shared setting, set on the phone).
    static var speak: Speak {
        get { UserDefaults.standard.string(forKey: "speak").flatMap(Speak.init) ?? .phone }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "speak") }
    }
    /// Shared setting; the server applies it, this only shows it. Unknown yet: what the server defaults to.
    static var midTurn: MidTurn {
        get { UserDefaults.standard.string(forKey: "midTurn").flatMap(MidTurn.init) ?? .steer }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "midTurn") }
    }
    static var replyWatch: Bool {
        get { UserDefaults.standard.object(forKey: "replyWatch") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "replyWatch") }
    }
    /// When the last note was sent (for the status widget).
    static var lastNoteAt: Date? {
        get { UserDefaults.standard.object(forKey: "lastNoteAt") as? Date }
        set { UserDefaults.standard.set(newValue, forKey: "lastNoteAt") }
    }
    /// The last note whose reply the watch is following.
    static var lastReplyClip: String? {
        get { UserDefaults.standard.string(forKey: "lastReplyClip") }
        set { UserDefaults.standard.set(newValue, forKey: "lastReplyClip") }
    }
    static func remember(_ s: ServerSettings) {
        engine = s.engine; autoStart = s.autoStart
        continuous = s.continuous ?? false
        micHold = s.micHold ?? false
        replyWatch = s.replyWatch ?? true
        speak = s.speak ?? .phone
        midTurn = s.midTurn ?? .steer
        guard let destinations = s.destinations else { return }   // an older server
        _ = upgraded
        if let main = s.main { mainChat = main }
        chats = destinations.filter { $0.id != mainChat?.id }   // Main has its own row
        t3Enabled = s.t3Enabled ?? false
        legacyTargets = s.legacyTargets ?? [:]
        // An old target moves to the real chat it meant. If it can't be resolved, ask him to pick.
        if target == "main" || target == "t3" {
            let moved = legacyTargets[target]
            target = moved?.id ?? ""
            targetTitle = moved?.title
        }
        // A chat that left the list stays chosen. Nothing here ever changes where notes go.
        if let current = chats.first(where: { $0.id == target }), current.title != ServerNames.unavailable { targetTitle = current.title }
        if let main = mainChat, main.id == target, let name = main.title, name != ServerNames.unavailable { targetTitle = name }
        // Only a real answer about this chat changes how it's marked. No answer: as it was.
        if let selected = s.selected, selected.id == target {
            targetState = selected.state
            if let name = selected.title, name != ServerNames.unavailable { targetTitle = name }
        }
    }
}

enum ServerNames { static let unavailable = "(name unavailable)" }

/// Client for the receiver's status and settings endpoints (the watch uploads clips separately).
enum API {
    /// The watch app sets this to keep a record of failed requests (NetLog). The iPhone app and the
    /// widget leave it nil. Called with the route ("history"), the HTTP status or the error, when the
    /// request started, and its metrics.
    nonisolated(unsafe) static var observer: ((_ route: String, _ result: Result<Int, Error>, _ started: Date, _ metrics: UploadMetrics) -> Void)?

    static func health() async -> Bool {
        guard let (_, r) = try? await get("health", timeout: 8) else { return false }
        return (r as? HTTPURLResponse)?.statusCode == 200
    }

    static func recent() async throws -> Recent { try await decode("recent", timeout: 15) }
    static func chats() async throws -> [Chat] { try await (decode("chats", timeout: 15) as ChatList).chats }
    static func t3Threads(selected: String = "") async throws -> T3Threads {
        try await decode(selected.isT3Target ? "t3threads?selected=\(selected)" : "t3threads", timeout: 15)
    }
    /// The chat's answer to a note: waiting, done (with text), none (timed out), or off.
    static func reply(clip: String) async throws -> ChatReply {
        try await decode("reply?clip=\(clip)", timeout: 10)
    }
    /// The reply to a note as speech (MP3).
    static func speech(clip: String) async throws -> Data {
        let (data, response) = try await get("tts?clip=\(clip)", timeout: 20)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.fileDoesNotExist) }
        return data
    }
    /// The chat's last messages. Given the version the watch already has, the server holds the
    /// request up to `wait` seconds until the chat changes, so news arrives the moment it lands.
    static func history(chat: String, version: String?, wait: Int) async throws -> ChatHistory {
        var path = "history?chat=\(chat)&limit=20"
        if let version { path += "&v=\(version)&wait=\(wait)" }
        return try await decode(path, timeout: TimeInterval(wait + 15))
    }
    static func dictionary() async throws -> [DictionaryEntry] { try await (decode("dictionary", timeout: 15) as Entries).entries }

    static func settings() async throws -> ServerSettings {
        let target = LocalSettings.target
        let path = target.isEmpty || target.isT3Target ? "settings" : "settings?selected=\(target)"
        let s: ServerSettings = try await decode(path, timeout: 10)
        LocalSettings.remember(s)
        return s
    }

    /// Changes only the fields given, e.g. ["engine": "local"].
    static func update(_ fields: [String: Any]) async throws -> ServerSettings {
        var request = URLRequest(url: Config.base.appending(path: "settings"))
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        Config.authorize(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: fields)
        let (data, _) = try await URLSession.shared.data(for: request)
        let s = try JSONDecoder().decode(ServerSettings.self, from: data)
        LocalSettings.remember(s)
        return s
    }

    private struct ChatList: Codable { let chats: [Chat] }
    private struct Entries: Codable { let entries: [DictionaryEntry] }

    private static func decode<T: Decodable>(_ path: String, timeout: TimeInterval) async throws -> T {
        let (data, _) = try await get(path, timeout: timeout)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func get(_ path: String, timeout: TimeInterval) async throws -> (Data, URLResponse) {
        var request = URLRequest(url: URL(string: path, relativeTo: Config.base)!)   // path may carry a query
        request.timeoutInterval = timeout
        Config.authorize(&request)
        guard let observer else { return try await URLSession.shared.data(for: request) }
        let metrics = UploadMetrics(), started = Date(), route = String(path.prefix { $0 != "?" })
        do {
            let result = try await URLSession.shared.data(for: request, delegate: metrics)
            observer(route, .success((result.1 as? HTTPURLResponse)?.statusCode ?? -1), started, metrics)
            return result
        } catch {
            observer(route, .failure(error), started, metrics)
            throw error
        }
    }
}

/// Why a note stopped recording, for the log: the first thing to check when one ends too soon.
enum NoteEnd: String {
    case tap, button, cutOff = "cut-off", lengthCap = "length-cap"
}

/// Where a request's time went, what link it used and how much it sent, from the system's own
/// record of the request. It also arrives when the request fails (NetLog). NWPathMonitor can't tell
/// us: watchOS limits the Network framework, and it said "offline" for every note that uploaded
/// fine. Non-cellular can still be Wi-Fi or the iPhone.
final class UploadMetrics: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var fields: [String: Any] { lock.withLock { stored } }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        // Int64: Int is 32-bit on the watch.
        var f: [String: Any] = ["bytesSent": task.countOfBytesSent, "bytesExpected": task.countOfBytesExpectedToSend]
        guard let t = metrics.transactionMetrics.last else {
            f["network"] = "unknown"   // no connection was ever made
            lock.withLock { stored = f }
            return
        }
        func ms(_ from: Date?, _ to: Date?) -> Int? {
            guard let from, let to else { return nil }
            return Int(max(0, min(3600, to.timeIntervalSince(from))) * 1000)
        }
        // No address on the far end: the connection never formed.
        f["network"] = t.remoteAddress == nil ? "unknown" : t.isCellular ? "cellular" : "not-cellular"
        f["expensive"] = t.isExpensive; f["constrained"] = t.isConstrained
        f["proxied"] = t.isProxyConnection; f["reused"] = t.isReusedConnection
        f["protocol"] = t.networkProtocolName
        f["localAddress"] = t.localAddress
        f["remoteAddress"] = t.remoteAddress
        f["connectMs"] = ms(t.fetchStartDate, t.connectEndDate)
        f["sendBodyMs"] = ms(t.requestStartDate, t.requestEndDate)
        f["waitMs"] = ms(t.requestEndDate, t.responseStartDate)
        lock.withLock { stored = f }
    }
}
