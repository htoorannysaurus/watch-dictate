import AppIntents
import Foundation

/// Opens Claudeputer Dictation already recording. Behind the Control (Control Center, Smart Stack,
/// and the Action Button), and Siri. Compiled into the app and the widget extension.
struct DictateIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Claudeputer Dictation"
    static let description = IntentDescription("Start recording a note for the chat you last picked.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        DictateLaunch.request()
        return .result()
    }
}

/// Hands a launch request from the intent to the app's model.
enum DictateLaunch {
    static let notification = Notification.Name("com.example.watchdictate.start")
    @MainActor static var pending = false

    @MainActor static func request() {
        pending = true
        NotificationCenter.default.post(name: notification, object: nil)
    }
}
