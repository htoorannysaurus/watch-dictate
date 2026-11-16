import Foundation
import WidgetKit

/// What the status widget shows: the chat notes go to and when the last note went. The app
/// and the widget extension share no storage (no App Group), so the app posts this to the
/// server and the widget reads it back from there, keeping its own copy for when offline.
enum WidgetState {
    static let statusKind = "com.example.watchdictate.status"

    struct Snapshot: Codable, Equatable {
        var targetTitle: String
        var isT3: Bool?
        var lastNote: Date?
    }

    private static let cacheKey = "widgetState"
    static var cached: Snapshot? {
        get { UserDefaults.standard.data(forKey: cacheKey).flatMap { try? decoder.decode(Snapshot.self, from: $0) } }
        set { UserDefaults.standard.set(newValue.flatMap { try? encoder.encode($0) }, forKey: cacheKey) }
    }

    /// App side: send it to the server when something shown changed, then refresh the widget.
    static func publish(_ s: Snapshot) {
        #if DEBUG
        return   // simulator builds share the real server; don't overwrite the watch's state
        #endif
        guard s != cached else { return }
        cached = s
        Task {
            var request = URLRequest(url: Config.base.appending(path: "widget"))
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            Config.authorize(&request)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? encoder.encode(s)
            _ = try? await URLSession.shared.data(for: request)
            WidgetCenter.shared.reloadTimelines(ofKind: statusKind)
        }
    }

    /// Widget side: the latest from the server, else the last one it saw.
    static func fetch() async -> Snapshot? {
        var request = URLRequest(url: Config.base.appending(path: "widget"))
        request.timeoutInterval = 10
        Config.authorize(&request)
        if let (data, response) = try? await URLSession.shared.data(for: request),
           (response as? HTTPURLResponse)?.statusCode == 200,
           let s = try? decoder.decode(Snapshot.self, from: data) {
            cached = s
            return s
        }
        return cached
    }

    private static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    private static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()
}
