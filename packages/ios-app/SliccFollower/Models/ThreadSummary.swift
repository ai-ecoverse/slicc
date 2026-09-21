import Foundation
import SliccTrayKit

#if canImport(FoundationModels)
    import FoundationModels
#endif







enum ThreadSummaryExcerpt {
    
    
    static let messageCount = 6
    static let charactersPerMessage = 600
    static let previewLength = 90

    
    
    static func make(from messages: [ChatMessage]) -> (key: String, text: String)? {
        guard let last = messages.last, last.isStreaming != true else { return nil }
        let spoken = messages.filter { !body(of: $0).isEmpty }.suffix(messageCount)
        guard !spoken.isEmpty else { return nil }
        let text = spoken.map { message in
            let speaker = message.role == .user ? "User" : "Assistant"
            return "\(speaker): \(String(body(of: message).prefix(charactersPerMessage)))"
        }.joined(separator: "\n\n")
        
        return ("\(last.id)#\(last.content.count)", text)
    }

    
    
    static func preview(from messages: [ChatMessage]) -> String? {
        guard let newest = messages.last(where: { !body(of: $0).isEmpty }) else { return nil }
        let line =
            body(of: newest).split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let plain = line.replacingOccurrences(
            of: #"[#*_`>]+|^\s*[-+]\s+|^\s*\d+\.\s+"#, with: "", options: .regularExpression)
        let trimmed = plain.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : clip(trimmed)
    }

    
    
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





protocol ThreadSummaryGenerating: Sendable {
    func summarize(_ excerpt: String) async -> String?
}





enum OnDeviceThreadSummarizer {
    
    
    
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
            
            
            let session = LanguageModelSession(instructions: Self.instructions)
            let response = try? await session.respond(
                to: "Conversation:\n\n\(excerpt)\n\nOne-line label:")
            return response.flatMap { ThreadSummaryExcerpt.tidy($0.content) }
        }
    }
#endif






@MainActor
final class ThreadSummaryStore: ObservableObject {
    @Published private(set) var lines: [String: String] = [:]

    private let generator: ThreadSummaryGenerating?
    
    
    private var keys: [String: String] = [:]
    private var queue: [(jid: String, key: String, text: String)] = []
    private var worker: Task<Void, Never>?
    
    private var inFlight: String?

    init(generator: ThreadSummaryGenerating? = OnDeviceThreadSummarizer.resolved()) {
        self.generator = generator
    }

    
    
    func refresh(buffers: [String: [ChatMessage]]) {
        for jid in keys.keys where buffers[jid] == nil { forget(jid) }
        for (jid, messages) in buffers {
            
            
            
            if ThreadSummaryExcerpt.preview(from: messages) == nil {
                forget(jid)
                continue
            }
            guard let excerpt = ThreadSummaryExcerpt.make(from: messages), keys[jid] != excerpt.key
            else { continue }
            keys[jid] = excerpt.key
            
            
            if lines[jid] == nil || generator == nil {
                lines[jid] = ThreadSummaryExcerpt.preview(from: messages)
            }
            guard generator != nil else { continue }
            queue.removeAll { $0.jid == jid }
            queue.append((jid, excerpt.key, excerpt.text))
        }
        startWorkerIfNeeded()
    }

    
    
    
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

    
    
    private func startWorkerIfNeeded() {
        guard worker == nil, let generator, !queue.isEmpty else { return }
        worker = Task { [weak self] in
            while !Task.isCancelled, let self, let job = self.queue.first {
                self.queue.removeFirst()
                self.inFlight = job.jid
                let line = await generator.summarize(job.text)
                
                guard !Task.isCancelled else { return }
                self.inFlight = nil
                if let line, self.keys[job.jid] == job.key { self.lines[job.jid] = line }
            }
            if !Task.isCancelled { self?.worker = nil }
        }
    }

    #if DEBUG
        
        func waitUntilIdle() async { await worker?.value }
        var pendingJobs: Int { queue.count }
    #endif
}





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
