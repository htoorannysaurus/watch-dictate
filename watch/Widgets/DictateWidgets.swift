import AppIntents
import SwiftUI
import WidgetKit

@main
struct DictateWidgets: WidgetBundle {
    var body: some Widget {
        DictateControl()
        DictateComplication()
        DictateStatusWidget()
    }
}

/// Control Center / Smart Stack button (watchOS 26 and later). Opens the app recording.
struct DictateControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.example.watchdictate.control") {
            ControlWidgetButton(action: DictateIntent()) {
                Label("Claudeputer Dictation", systemImage: "mic.fill")
            }
        }
        .displayName("Claudeputer Dictation")
        .description("Record a note for the chat you last picked.")
    }
}

/// Watch face complication. Tapping it opens the app recording.
struct DictateComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.example.watchdictate.complication", provider: Provider()) { _ in
            ComplicationView()
        }
        .configurationDisplayName("Claudeputer Dictation")
        .description("Tap to start a Claudeputer Dictation note.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline])
    }

    struct Entry: TimelineEntry { let date: Date }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> Entry { Entry(date: .now) }
        func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now)) }
        func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
            completion(Timeline(entries: [Entry(date: .now)], policy: .never))
        }
    }
}

struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            switch family {
            case .accessoryInline:
                Label("Claudeputer Dictation", systemImage: "mic.fill")
            case .accessoryCorner:
                Image(systemName: "mic.fill").font(.title2).widgetLabel("Claudeputer Dictation")
            default:
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "mic.fill").font(.title2)
                }
            }
        }
        .widgetURL(URL(string: "watchdictate://record"))
        .accessibilityLabel("Start Claudeputer Dictation")
        .containerBackground(.clear, for: .widget)
    }
}

/// Smart Stack / rectangular face slot: which chat notes go to and when the last one went.
/// Tapping it opens the app recording.
struct DictateStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetState.statusKind, provider: Provider()) { entry in
            StatusView(entry: entry)
        }
        .configurationDisplayName("Claudeputer Dictation")
        .description("Where your notes go and when the last one went. Tap to record.")
        .supportedFamilies([.accessoryRectangular])
    }

    struct Entry: TimelineEntry { let date: Date; let state: WidgetState.Snapshot }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> Entry {
            Entry(date: .now, state: .init(targetTitle: "Your chat", isT3: false, lastNote: nil))
        }
        func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
            if context.isPreview { completion(placeholder(in: context)); return }
            Task { completion(Entry(date: .now, state: await WidgetState.fetch() ?? placeholder(in: context).state)) }
        }
        /// The app reloads the widget when anything changes. Hourly as a backstop.
        func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
            Task {
                guard let state = await WidgetState.fetch() else {
                    completion(Timeline(entries: [placeholder(in: context)], policy: .after(.now.addingTimeInterval(900))))
                    return
                }
                completion(Timeline(entries: [Entry(date: .now, state: state)], policy: .after(.now.addingTimeInterval(3600))))
            }
        }
    }

    struct StatusView: View {
        let entry: Entry

        var body: some View {
            HStack(spacing: 8) {
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "mic.fill").font(.title3)
                }
                .frame(width: 40, height: 40)
                .widgetAccentable()
                VStack(alignment: .leading, spacing: 1) {
                    Text("Dictate").font(.headline).widgetAccentable()
                    Label(entry.state.targetTitle, systemImage: "arrow.turn.up.right")
                        .font(.caption).lineLimit(1)
                    lastNote.font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .widgetURL(URL(string: "watchdictate://record"))
            .containerBackground(.clear, for: .widget)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Tap to record")
        }

        @ViewBuilder private var lastNote: some View {
            if let at = entry.state.lastNote {
                if Calendar.current.isDateInToday(at) {
                    Text("Last note \(at.formatted(date: .omitted, time: .shortened))")
                } else {
                    Text("Last note \(at.formatted(.dateTime.weekday(.abbreviated).hour().minute()))")
                }
            } else {
                Text("No notes yet")
            }
        }
    }
}
