import AppIntents
import SwiftUI

@main
struct WatchDictateApp: App {
    @State private var model = DictationModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        NetLog.install()
        Reminders.shared.install()
    }

    var body: some Scene {
        WindowGroup {
            RecordView(model: model)
                .task { await model.launched() }
                .onOpenURL { _ in model.startTapMode() }   // complication tap
                .onReceive(NotificationCenter.default.publisher(for: DictateLaunch.notification)) { _ in
                    model.consumeLaunchRequest()
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.becameActive() } else { model.wentInactive() }
        }
    }
}

/// Siri phrases and Spotlight. The Action Button uses the Control (DictateWidgets) instead: its
/// Shortcut list only shows the iPhone's Shortcuts library, which this watch-only app can't reach.
struct DictateShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: DictateIntent(),
            phrases: ["Start \(.applicationName)", "Record with \(.applicationName)"],
            shortTitle: "Start Claudeputer Dictation",
            systemImageName: "mic.fill"
        )
    }
}
