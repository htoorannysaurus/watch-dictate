import UserNotifications
import WatchKit

/// Wrist taps for two things the user can't see with their arm down: the mic is still on, and a note
/// hasn't sent. They are local notifications handed to the system ahead of time, so they fire
/// whether or not the app is running, and are taken back the moment they stop being true.
@MainActor
final class Reminders: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Reminders()
    private let center = UNUserNotificationCenter.current()
    nonisolated private static let recording = "recording-"
    nonisolated private static let stuck = "stuck"
    /// Minutes into a note at which the wrist is tapped. No limit on a note's length (
    /// 2026-10-29): these only say it's still going.
    private static let minutes = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360]
    private static var recordingIds: [String] { minutes.map { recording + String($0) } }

    /// At launch. A note that was cut short by a crash leaves nothing behind to fire later.
    func install() {
        center.delegate = self
        recordingEnded()
    }

    /// Asked once, after the first note is sent. Refused: the app works as before, without the taps.
    func ask() {
        #if targetEnvironment(simulator)
        // Simulator screenshots: the system's question would cover the screen. `-askReminders` shows it.
        // Simulator only, never DEBUG: a Debug build installed on the real watch must still ask.
        if !ProcessInfo.processInfo.arguments.contains("-askReminders") { return }
        #endif
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func recordingStarted(chat: String) {
        recordingEnded()
        var times = Self.minutes.map { (id: Self.recording + String($0), after: TimeInterval($0 * 60), label: Self.length($0)) }
        #if DEBUG
        let test = UserDefaults.standard.double(forKey: "remindSeconds")   // `-remindSeconds 5`: one tap, soon
        if test > 0 { times = [(Self.recording + "5", test, "5 min")] }
        #endif
        for t in times {
            let content = UNMutableNotificationContent()
            content.title = "Still recording"
            content.body = "\(t.label) so far, for \(chat). Open to send or discard."
            content.sound = .default
            center.add(UNNotificationRequest(identifier: t.id, content: content,
                                             trigger: UNTimeIntervalNotificationTrigger(timeInterval: t.after, repeats: false)))
        }
    }

    func recordingEnded() {
        center.removePendingNotificationRequests(withIdentifiers: Self.recordingIds)
        center.removeDeliveredNotifications(withIdentifiers: Self.recordingIds)
    }

    /// A note didn't send. If it still hasn't in a few minutes, say so once.
    func noteStuck(count: Int) {
        let content = UNMutableNotificationContent()
        content.title = count == 1 ? "A note hasn't sent" : "\(count) notes haven't sent"
        content.body = "Open Dictation to try again."
        content.sound = .default
        center.add(UNNotificationRequest(identifier: Self.stuck, content: content,
                                         trigger: UNTimeIntervalNotificationTrigger(timeInterval: 180, repeats: false)))
    }

    func nothingStuck() {
        center.removePendingNotificationRequests(withIdentifiers: [Self.stuck])
        center.removeDeliveredNotifications(withIdentifiers: [Self.stuck])
    }

    private static func length(_ minutes: Int) -> String {
        minutes < 60 ? "\(minutes) min" : minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
    }

    /// The app is on screen, which already shows the red timer or the waiting note: a tap on the
    /// wrist is enough, with no banner over it.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        if notification.request.identifier.hasPrefix(Self.recording) {
            await MainActor.run { WKInterfaceDevice.current().play(.notification) }
        }
        return []
    }
}
