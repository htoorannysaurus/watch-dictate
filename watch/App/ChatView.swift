import SwiftUI

/// Keeps the chat page current while the app is open: one request held open on the server,
/// answered the moment the chat changes (or after 20 s with no news), then asked again.
@MainActor
@Observable
final class ChatFeed {
    private(set) var history: ChatHistory?
    private(set) var failed = false
    /// Called after each change, e.g. to fetch a reply that just finished.
    @ObservationIgnored var onChange: (() -> Void)?
    /// Called with an agent reply that just landed (never for what a chat's first load shows).
    @ObservationIgnored var onReply: ((ChatHistory.Item) -> Void)?
    private var newestReplyId: String?
    private var chat = ""
    private var loop: Task<Void, Never>?

    /// Follow a chat by id; a different chat starts over, and none yet follows nothing.
    func follow(_ chat: String) {
        if chat.isEmpty { stop(); history = nil; self.chat = ""; return }
        if chat == self.chat, loop != nil { return }
        loop?.cancel()
        if chat != self.chat { history = nil }
        self.chat = chat
        loop = Task { await run(chat) }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    private func run(_ chat: String) async {
        var backoff = 1.0
        while !Task.isCancelled {
            do {
                let next = try await API.history(chat: chat, version: history?.version, wait: 20)
                guard !Task.isCancelled else { return }
                failed = false
                backoff = 1
                if next.version != history?.version {
                    let firstLoad = history == nil
                    history = next
                    if let newest = next.items.last(where: { !$0.isMe }), newest.id != newestReplyId {
                        newestReplyId = newest.id
                        // Fresh only: one that came in while the app was closed already had its push.
                        if !firstLoad, let at = newest.date, Date().timeIntervalSince(at) < 60 { onReply?(newest) }
                    }
                    onChange?()
                }
            } catch {
                guard !Task.isCancelled else { return }
                failed = true
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 30)
            }
        }
    }
}

/// The chat page, one swipe left of the mic: the last messages, newest at the bottom. It opens
/// on the newest message; older replies show their first lines (tap to read all of it).
///
/// `previewing`: read a T3 thread from the T3 screen, with its own feed. Nothing about it changes where
/// notes go until "Send notes here" is tapped.
struct ChatView: View {
    let model: DictationModel
    var previewing: T3Thread? = nil
    var close: () -> Void = {}
    @State private var ownFeed = ChatFeed()
    @Environment(\.scenePhase) private var scenePhase
    @State private var reading: ReadingText?
    @State private var atBottom = true
    @State private var shownNewest: String?
    private static let bottom = "bottom"

    init(model: DictationModel, previewing: T3Thread? = nil, close: @escaping () -> Void = {}) {
        self.model = model; self.previewing = previewing; self.close = close
    }

    private var feed: ChatFeed { previewing == nil ? model.feed : ownFeed }
    private var isT3: Bool { previewing != nil || model.target.isT3Target }
    private var tint: Color { isT3 ? Theme.t3 : Theme.accent }
    private var items: [ChatHistory.Item] { feed.history?.items ?? [] }
    private var newestReply: String? { items.last { !$0.isMe }?.id }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if previewing == nil, !model.hasTarget {
                        Text("Pick a chat first").font(.footnote).foregroundStyle(.secondary)
                    } else if previewing == nil, model.targetState == "deleted" {
                        Text("This chat was deleted").font(.footnote).foregroundStyle(.secondary)
                    } else if feed.history == nil {
                        placeholder
                    } else if items.isEmpty {
                        Text("No messages yet").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(items) { item in
                        if item.isMe { mine(item) } else { reply(item, full: item.id == newestReply) }
                    }
                    if previewing == nil, model.status == .sending { sending }
                    if let working = feed.history?.working { workingLine(working) }
                    if previewing == nil { talkButton.id(Self.bottom) } else { sendHereButton.id(Self.bottom) }
                }
                .padding(.horizontal, 2)
            }
            .defaultScrollAnchor(.bottom)
            // Room under the clock and title: a reply scrolled to its first line (and the reader)
            // starts clear of them instead of touching the time.
            .safeAreaPadding(.top, Theme.clockClearance)
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 60
            } action: { _, bottom in atBottom = bottom }
            // A new message brings the view to its first line unless you're reading further up;
            // a new working line keeps the bottom in view.
            .onChange(of: feed.history?.version) { _, _ in
                if items.last?.id != shownNewest, atBottom || shownNewest == nil { showNewest(proxy) }
                else if atBottom { scroll(proxy) { $0.scrollTo(Self.bottom, anchor: .bottom) } }
            }
            .onChange(of: model.page) { _, page in if page == 1 { showNewest(proxy) } }
        }
        .navigationTitle(feed.history?.chat ?? previewing?.title ?? model.targetTitle)
        .containerBackground(isT3 ? AnyShapeStyle(Theme.t3Background) : AnyShapeStyle(Color.black), for: .navigation)
        .onAppear { if let previewing { ownFeed.follow(previewing.id) } }
        .onDisappear { if previewing != nil { ownFeed.stop() } }
        // Wrist down: a thread being read stops asking, like the main feed does.
        .onChange(of: scenePhase) { _, phase in
            guard let previewing else { return }
            if phase == .active { ownFeed.follow(previewing.id) } else { ownFeed.stop() }
        }
        .sheet(item: $reading) { r in NavigationStack { ReplyView(text: r.text, chat: nil) } }
    }

    /// The newest message from its first line; a long reply then reads top to bottom.
    private func showNewest(_ proxy: ScrollViewProxy) {
        shownNewest = items.last?.id
        var target = items.last?.id ?? Self.bottom
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-chatOlder"), items.count > 4 { target = items[items.count - 5].id }   // screenshots
        #endif
        scroll(proxy) { $0.scrollTo(target, anchor: .top) }
    }

    /// After this update's layout, or the scroll lands on where the content used to be.
    private func scroll(_ proxy: ScrollViewProxy, _ move: @escaping (ScrollViewProxy) -> Void) {
        Task {
            try? await Task.sleep(for: .milliseconds(60))
            withAnimation(.easeOut(duration: 0.25)) { move(proxy) }
        }
    }

    private func mine(_ item: ChatHistory.Item) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(item.text)
                .font(.callout)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(tint, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            Text((item.watch == true ? "⌚ " : "") + Self.time(item.date))
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 20)
        .id(item.id)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func reply(_ item: ChatHistory.Item, full: Bool) -> some View {
        let text = Text(ReplyView.markdown(item.text)).font(.callout)
        if full {
            VStack(alignment: .leading, spacing: 2) {
                text.frame(maxWidth: .infinity, alignment: .leading)
                Text(Self.time(item.date)).font(.caption2).foregroundStyle(.secondary)
            }
            .id(item.id)
        } else {
            // A card per older reply: each tap target has an edge, and two replies in a row
            // don't run together.
            Button { reading = ReadingText(text: item.text) } label: {
                text.lineLimit(4).foregroundStyle(.white.opacity(0.8))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .multilineTextAlignment(.leading)
                    .padding(10)
                    .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .id(item.id)
            .accessibilityHint("Tap to read all of it")
        }
    }

    private var sending: some View {
        Text("Sending…")
            .font(.callout).foregroundStyle(.white.opacity(0.7))
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(tint.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func workingLine(_ working: ChatHistory.Working) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: "ellipsis")
                .foregroundStyle(tint)
                .symbolEffect(.variableColor.iterative, options: .repeating)
            Text(working.line ?? "Working…").lineLimit(3)
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }

    @ViewBuilder private var placeholder: some View {
        if feed.failed {
            Label("Can't reach the chat", systemImage: "wifi.exclamationmark").font(.footnote).foregroundStyle(.secondary)
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    /// The second deliberate tap: reading a thread first shows what it is before notes go there.
    @ViewBuilder private var sendHereButton: some View {
        if let previewing {
            if previewing.id == model.target {
                Label("Notes go here", systemImage: "checkmark").font(.footnote).foregroundStyle(Theme.t3)
                    .frame(maxWidth: .infinity).padding(.top, 10)
            } else {
                Button {
                    model.select(id: previewing.id, title: previewing.title)
                    close()
                } label: { Label("Send notes here", systemImage: "arrow.turn.up.right") }
                .tint(Theme.t3)
                .padding(.top, 10)
            }
        }
    }

    /// Back to the mic page, recording.
    private var talkButton: some View {
        Button { model.talkFromChat() } label: {
            Label(model.mode == nil ? "Talk" : "Recording…", systemImage: "mic.fill")
        }
        .padding(.top, 10)
    }

    static func time(_ date: Date?) -> String {
        guard let date else { return "" }
        return Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
}

struct ReadingText: Identifiable {
    let id = UUID()
    let text: String
}
