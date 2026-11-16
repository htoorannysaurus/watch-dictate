import SwiftUI

enum T3Route: Hashable {
    case list
    case thread(T3Thread)
}

/// The T3 screen: every thread that isn't settled or snoozed, from T3, plus the chosen one flagged if it
/// is. Tap one to read it; "Send notes here" on that page is what chooses it, so two taps and a look at the thread.
struct T3ThreadsView: View {
    let model: DictationModel
    @State private var threads: [T3Thread]?
    @State private var stale = false

    var body: some View {
        List {
            if let threads {
                ForEach(threads) { thread in
                    NavigationLink(value: T3Route.thread(thread)) {
                        HStack(spacing: 7) {
                            Image(systemName: thread.running ? "ellipsis.circle.fill" : "circle.fill")
                                .font(thread.running ? .footnote : .system(size: 9))
                                .foregroundStyle(Theme.t3)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(thread.title).lineLimit(2)
                                if let flag = thread.flag {
                                    Text(flag).font(.caption2).foregroundStyle(.yellow).lineLimit(1)
                                } else if let project = thread.project {
                                    Text(project).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                            Spacer(minLength: 0)
                            if thread.id == model.target { Image(systemName: "checkmark").foregroundStyle(Theme.t3) }
                        }
                    }
                }
                if stale {
                    Label("Can't reach T3", systemImage: "wifi.exclamationmark").font(.caption2).foregroundStyle(.yellow)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("T3 threads")
        .containerBackground(Theme.t3Background, for: .navigation)
        .task { await load() }
    }

    private func load() async {
        guard let r = try? await API.t3Threads(selected: model.target) else {
            stale = true
            if threads == nil, model.target.isT3Target {
                threads = [T3Thread(id: model.target, title: model.targetTitle, project: nil, running: false, flag: nil)]
            } else if threads == nil { threads = [] }
            return
        }
        threads = r.threads
        stale = r.stale
    }
}
