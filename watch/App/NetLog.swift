import Foundation
import WatchConnectivity
import WatchKit

/// Failed requests, kept on the watch until a request works, then sent to the server (POST /netlog)
/// so a "No connection" can be explained afterwards from the log (`node server/log.mjs`, /log).
/// Each record has the real error, the link the request used (from the system's metrics for that
/// request), whether the phone was reachable, whether the app was on screen, the try number, how
/// long it ran and how much it sent. The same poll failing again and again is one record with a
/// count. Server side: server/lib/netlog.mjs.
@MainActor
final class NetLog {
    static let shared = NetLog()
    private static let cap = 50

    private let file: URL
    private var records: [[String: Any]]
    /// Ids in the batch being delivered: they aren't merged into, so the server gets what it stores.
    private var sending = Set<String>()
    /// Records still waiting for their request's metrics: not sent until they have them.
    private var awaitingMetrics = Set<String>()
    /// When the app last left the screen. A request that ran across it was likely cut off by it.
    var lastInactiveAt: Date?

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        file = support.appending(path: "netlog.json")
        records = (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
    }

    var count: Int { records.count }

    /// Watches the app's GET requests (history, reply, settings, ...). Uploads report from Uploader.
    static func install() {
        API.observer = { route, result, started, metrics in
            Task { @MainActor in
                switch result {
                case .success(let status) where status >= 500 || status < 0:
                    shared.record(route: route, status: status, started: started, metrics: metrics)
                case .success:
                    shared.deliver()
                case .failure(let error):
                    if !isCancel(error) { shared.record(route: route, error: error, started: started, metrics: metrics) }
                }
            }
        }
    }

    /// Short words for the screen: what kind of "no connection" it was.
    nonisolated static func reason(_ error: Error) -> String {
        guard let e = error as? URLError else { return "No connection" }
        switch e.code {
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .callIsActive: return "Offline"
        case .timedOut: return "Timed out"
        case .networkConnectionLost: return "Connection dropped"
        case .cannotFindHost, .dnsLookupFailed: return "Can't find the server"
        case .cannotConnectToHost: return "Can't reach the server"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected:
            return "Secure connection failed"
        case .cancelled: return "Cancelled"
        default: return "No connection"
        }
    }

    /// The app cancelled it on purpose (wrist down, chat switched): not a failure.
    nonisolated static func isCancel(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    static var appState: String {
        switch WKApplication.shared().applicationState {
        case .active: "active"
        case .inactive: "inactive"
        case .background: "background"
        @unknown default: "unknown"
        }
    }

    /// Records one failed request: an error, or an HTTP status that isn't an answer from the app.
    func record(route: String, error: Error? = nil, status: Int? = nil, clipId: String? = nil, attempt: Int? = nil,
                started: Date, appAtStart: String? = nil, metrics: UploadMetrics) {
        let ranMs = Int(max(0, min(86_400, Date().timeIntervalSince(started))) * 1000)
        let appNow = Self.appState
        let leftDuring = lastInactiveAt.map { $0 > started } ?? false
        let app = leftDuring ? "\(appAtStart.map { "\($0), " } ?? "")left screen, then \(appNow)"
            : appAtStart.map { $0 == appNow ? appNow : "\($0), then \(appNow)" } ?? appNow
        let phone: Bool? = WCSession.isSupported() && WCSession.default.activationState == .activated ? WCSession.default.isReachable : nil
        var r: [String: Any] = [
            "id": UUID().uuidString, "route": route, "at": Self.ms(started), "lastAt": Self.ms(Date()), "count": 1,
            "ranMs": ranMs, "app": app,
            "version": AppVersion.text,
        ]
        if let clipId { r["clipId"] = clipId }
        if let attempt { r["attempt"] = attempt }
        if let phone { r["phoneReachable"] = phone }
        if let status {
            r["status"] = status
            r["reason"] = "Server error \(status)"
        }
        if let error {
            let ns = error as NSError
            r["code"] = ns.code
            r["domain"] = ns.domain
            r["reason"] = Self.reason(error)
            r["detail"] = String(ns.localizedDescription.prefix(200))
            if let under = ns.userInfo[NSUnderlyingErrorKey] as? NSError { r["underlying"] = "\(under.domain) \(under.code)" }
            if let d = ns.userInfo["_kCFStreamErrorDomainKey"], let c = ns.userInfo["_kCFStreamErrorCodeKey"] { r["stream"] = "\(d) \(c)" }
            if let why = (error as? URLError)?.networkUnavailableReason {
                r["unavailable"] = switch why {
                case .cellular: "cellular"
                case .expensive: "expensive"
                case .constrained: "constrained"
                @unknown default: "other"
                }
            }
        }
        // Saved now: the app may be suspended any moment (a failure often comes with the wrist down).
        // The request's metrics arrive just after it ends; they're added to the record then.
        guard add(r), let id = r["id"] as? String else { return }
        awaitingMetrics.insert(id)
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            awaitingMetrics.remove(id)
            guard let i = records.firstIndex(where: { $0["id"] as? String == id }) else { return }
            for (k, v) in metrics.fields where records[i][k] == nil { records[i][k] = v }
            save()
        }
    }

    /// Adds a record, or counts it on an earlier one like it. True if it's a new record.
    @discardableResult
    private func add(_ r: [String: Any]) -> Bool {
        // A poll failing the same way as one of the last few records: count it there instead.
        let same = { (x: [String: Any]) in
            x["clipId"] == nil && x["route"] as? String == r["route"] as? String
                && x["code"] as? Int == r["code"] as? Int && x["status"] as? Int == r["status"] as? Int
                && !self.sending.contains(x["id"] as? String ?? "")
        }
        if r["clipId"] == nil, let i = records.indices.suffix(5).last(where: { same(records[$0]) }) {
            records[i]["count"] = ((records[i]["count"] as? Int) ?? 1) + 1
            records[i]["lastAt"] = r["lastAt"]
            records[i]["app"] = r["app"]
            save()
            return false
        }
        records.append(r)
        if records.count > Self.cap { records.removeFirst(records.count - Self.cap) }
        save()
        return true
    }

    /// A request just worked: send what's kept. Only the ids sent are cleared, and only once the
    /// server has them; anything that fails meanwhile waits for the next time.
    func deliver() {
        let batch = records.filter { !awaitingMetrics.contains($0["id"] as? String ?? "") }
        guard !batch.isEmpty, sending.isEmpty else { return }
        let ids = Set(batch.compactMap { $0["id"] as? String })
        guard let body = try? JSONSerialization.data(withJSONObject: ["failures": batch]) else { return }
        sending = ids
        Task {
            defer { sending = [] }
            var request = URLRequest(url: Config.base.appending(path: "netlog"))
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            Config.authorize(&request)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            guard let (_, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            records.removeAll { ids.contains($0["id"] as? String ?? "") }
            save()
        }
    }

    private func save() {
        guard let data = try? JSONSerialization.data(withJSONObject: records) else { return }
        try? data.write(to: file, options: .atomic)
    }

    /// Epoch milliseconds. Int64: Int is 32-bit on the watch.
    private static func ms(_ date: Date) -> Int64 { Int64(date.timeIntervalSince1970 * 1000) }
}
