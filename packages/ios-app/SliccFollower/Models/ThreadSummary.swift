import Foundation
import SliccTrayKit

#if canImport(FoundationModels)
    import FoundationModels
#endif

// MARK: - What gets summarized

/// The tail of a transcript, reduced to what a one-line summary needs.
///
/// Pure, so the rules — which rows count, how much of each, when a summary is
/// stale — are tested without a model.
enum ThreadSummaryExcerpt {
    /// "The last few turns": enough to say what the thread is about NOW, small
    /// enough to stay far inside the on-device model's context window.
    static let messageCount = 6
    static let charactersPerMessage = 600
    static let previewLength = 90

    /// `nil` when there is nothing to say yet, or the last row is still
    /// streaming — a summary of half a reply is stale before it is shown.
    static func make(from messages: [ChatMessage]) -> (key: String, text: String)? {
        guard let last = messages.last, last.isStreaming != true else { return nil }
        let spoken = messages.filter { !body(of: $0).isEmpty }.suffix(messageCount)
        guard !spoken.isEmpty else { return nil }
        let text = spoken.map { message in
            let speaker = message.role == .user ? "User" : "Assistant"
            return "\(speaker): \(String(body(of: message).prefix(charactersPerMessage)))"
        }.joined(separator: "\n\n")
        // The id names the turn, the count catches an edit to the same row.
        return ("\(last.id)#\(last.content.count)", text)
    }

    /// What the row shows until (or instead of) a model's summary: the first
    /// line of the newest thing anyone said, with the markdown scaffolding off.
    static func preview(from messages: [ChatMessage]) -> String? {
        guard let newest = messages.last(where: { !body(of: $0).isEmpty }) else { return nil }
        let line =
            body(of: newest).split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let plain = line.replacingOccurrences(
            of: #"[#*_`>]+|^\s*[-+]\s+|^\s*\d+\.\s+"#, with: "", options: .regularExpression)
        let trimmed = plain.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : clip(trimmed)
    }

    /// One line, whatever the model returned: first line, no wrapping quotes,
    /// no trailing full stop, clipped.
    static func tidy(_ raw: String) -> String? {
        let line = raw.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        var text = line.trimmingCharacters(in: .whitespaces)
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’"))
        if text.hasSuffix(".") { text.removeLast() }
        return text.isEmpty ? nil : clip(text)
    }

    private static func clip(_ text: String) -> String {
        text.count <= previewLength ? text : String(text.prefix(previewLength - 1)) + "…"
    }

    private static func body(of message: ChatMessage) -> String {
        message.content.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Who summarizes

/// A one-line summarizer. A protocol so the store is tested with a scripted
/// one, and so a device without a usable model simply has none.
protocol ThreadSummaryGenerating: Sendable {
    func summarize(_ excerpt: String) async -> String?
}

/// Apple's on-device foundation model. Nothing leaves the device: a transcript
/// can hold anything, and a thread list is not worth a network round trip to a
/// third party. Unavailable (older hardware, Apple Intelligence off, model
/// still downloading) means `make()` returns `nil` and rows keep the preview.
enum OnDeviceThreadSummarizer {
    /// The real model, unless a UI test passed `-uiTestThreadSummaryDelay`.
    /// Not on the store: that type is `@MainActor`, and a default argument
    /// is evaluated outside the actor.
    static func resolved() -> ThreadSummaryGenerating? {
        #if DEBUG
            if let scripted = UITestHooks.threadSummaryGenerator() { return scripted }
        #endif
        return make()
    }

    static func make() -> ThreadSummaryGenerating? {
        #if canImport(FoundationModels)
            guard case .available = SystemLanguageModel.default.availability else { return nil }
            return FoundationModelSummarizer()
        #else
            return nil
        #endif
    }
}

#if canImport(FoundationModels)
    private struct FoundationModelSummarizer: ThreadSummaryGenerating {
        private static let instructions = """
            You label conversations between a user and a coding assistant for a sidebar. \
            Reply with ONE short line, at most eight words, saying what the conversation is \
            currently about. No quotes, no trailing period, no preamble.
            """

        func summarize(_ excerpt: String) async -> String? {
            // A fresh session per summary: threads must not leak into each
            // other's context, and one excerpt is the whole job.
            let session = LanguageModelSession(instructions: Self.instructions)
            let response = try? await session.respond(
                to: "Conversation:\n\n\(excerpt)\n\nOne-line label:")
            return response.flatMap { ThreadSummaryExcerpt.tidy($0.content) }
        }
    }
#endif

// MARK: - The store

/// One line per unit for the thread list. A row gets the plain preview at once
/// and the model's summary when it arrives; both are keyed to the transcript's
/// tail, so an unchanged thread is never summarized twice.
@MainActor
final class ThreadSummaryStore: ObservableObject {
    @Published private(set) var lines: [String: String] = [:]

    private let generator: ThreadSummaryGenerating?
    /// The excerpt key each unit's `lines` entry was made from (or is being
    /// made from), so a roster tick does not re-queue work already done.
    private var keys: [String: String] = [:]
    private var queue: [(jid: String, key: String, text: String)] = []
    private var worker: Task<Void, Never>?
    /// The unit the model is summarizing right now, so `suspend` can forget it.
    private var inFlight: String?

    init(generator: ThreadSummaryGenerating? = OnDeviceThreadSummarizer.resolved()) {
        self.generator = generator
    }

    /// Fold the current buffers in. Cheap when nothing changed — this runs on
    /// every roster push while the list is on screen.
    func refresh(buffers: [String: [ChatMessage]]) {
        for jid in keys.keys where buffers[jid] == nil { forget(jid) }
        for (jid, messages) in buffers {
            // A reset thread (New Session's empty snapshot) says nothing yet:
            // the old conversation's line must go, and so must any job still
            // queued for it. A streaming tail is NOT this — it keeps its line.
            if ThreadSummaryExcerpt.preview(from: messages) == nil {
                forget(jid)
                continue
            }
            guard let excerpt = ThreadSummaryExcerpt.make(from: messages), keys[jid] != excerpt.key
            else { continue }
            keys[jid] = excerpt.key
            // Keep a model's line for the previous tail on screen until the new
            // one lands; only a unit with nothing yet gets the raw preview.
            if lines[jid] == nil || generator == nil {
                lines[jid] = ThreadSummaryExcerpt.preview(from: messages)
            }
            guard generator != nil else { continue }
            queue.removeAll { $0.jid == jid }
            queue.append((jid, excerpt.key, excerpt.text))
        }
        startWorkerIfNeeded()
    }

    /// The list left the screen: stop making lines nobody can see. Lines
    /// already shown stay; work not finished is forgotten, so the next
    /// `refresh` (the list coming back) queues it again.
    func suspend() {
        worker?.cancel()
        worker = nil
        for job in queue { keys[job.jid] = nil }
        queue.removeAll()
        if let inFlight { keys[inFlight] = nil }
        inFlight = nil
    }

    private func forget(_ jid: String) {
        keys[jid] = nil
        lines[jid] = nil
        queue.removeAll { $0.jid == jid }
    }

    /// One summary at a time: the model is a shared, serial resource, and the
    /// list is decoration — it must never compete with the transcript.
    private func startWorkerIfNeeded() {
        guard worker == nil, let generator, !queue.isEmpty else { return }
        worker = Task { [weak self] in
            while !Task.isCancelled, let self, let job = self.queue.first {
                self.queue.removeFirst()
                self.inFlight = job.jid
                let line = await generator.summarize(job.text)
                // Suspended, or the thread moved on, while the model was thinking.
                guard !Task.isCancelled else { return }
                self.inFlight = nil
                if let line, self.keys[job.jid] == job.key { self.lines[job.jid] = line }
            }
            if !Task.isCancelled { self?.worker = nil }
        }
    }

    #if DEBUG
        /// Lets a test wait for the queue to drain.
        func waitUntilIdle() async { await worker?.value }
        var pendingJobs: Int { queue.count }
    #endif
}

/// What the shell owns. `@StateObject` builds this once — its wrapped value is
/// an autoclosure — and the host never publishes, so a line arriving redraws
/// the rows that read `store` and not the shell. Holding the store in `@State`
/// directly would rebuild it on every `ChatView` init.
@MainActor
final class ThreadSummaryHost: ObservableObject {
    let store: ThreadSummaryStore

    init(store: ThreadSummaryStore) {
        self.store = store
    }

    convenience init() {
        self.init(store: ThreadSummaryStore())
    }
}
