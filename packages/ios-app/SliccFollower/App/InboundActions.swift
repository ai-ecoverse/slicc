import Foundation
import SwiftUI





@MainActor
final class InboundActionCoordinator: ObservableObject {

    
    
    static let shared = InboundActionCoordinator()

    
    
    
    
    struct PendingOpen: Identifiable, Equatable {
        let id: UUID
        let url: URL
        let needsConfirmation: Bool
        let receivedAt: Date
    }

    @Published private(set) var pendingOpen: PendingOpen?

    
    
    
    
    struct PendingPrompt: Identifiable, Equatable {
        let id: UUID
        let prompt: String
        let xSuccess: URL?
        let xError: URL?
        let xCancel: URL?
        
        
        let needsConfirmation: Bool
        let receivedAt: Date
    }

    @Published private(set) var pendingPrompt: PendingPrompt?

    
    struct PendingTranscript: Identifiable, Equatable {
        let id: UUID
        let receivedAt: Date
    }

    @Published private(set) var pendingTranscript: PendingTranscript?

    
    
    
    
    
    struct PendingSelection: Identifiable, Equatable {
        let id: UUID
        let scoopJid: String
        let receivedAt: Date
    }

    @Published private(set) var pendingSelection: PendingSelection?

    
    
    
    enum Phase: Equatable {
        case running(String)
        case failed(String)
    }

    @Published var phase: Phase?

    
    
    private var resultContinuations: [UUID: CheckedContinuation<String, Error>] = [:]

    static let maxPromptLength = 8192
    static let maxTranscriptBytes = 512 * 1024
    
    
    static let maxJidLength = 256

    
    
    private var lastAccepted: (url: URL, at: Date)?
    private var lastPromptAccepted: (prompt: String, at: Date)?

    static let maxURLLength = 2048
    private static let dedupWindow: TimeInterval = 3

    
    
    @discardableResult
    func receive(url raw: URL, needsConfirmation: Bool, now: Date = Date()) -> Bool {
        guard let url = Self.validated(raw) else { return false }
        if let last = lastAccepted, last.url == url,
            now.timeIntervalSince(last.at) < Self.dedupWindow
        {
            return true
        }
        lastAccepted = (url, now)
        pendingOpen = PendingOpen(
            id: UUID(), url: url, needsConfirmation: needsConfirmation, receivedAt: now)
        return true
    }

    
    
    
    
    
    
    @discardableResult
    func receive(deepLink: URL) -> Bool {
        guard deepLink.scheme?.lowercased() == "slicc",
            let components = URLComponents(url: deepLink, resolvingAgainstBaseURL: false)
        else { return false }
        let host = deepLink.host()?.lowercased() ?? ""
        let action =
            host == "x-callback-url"
            ? components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
            : host
        func query(_ name: String) -> String? {
            components.queryItems?.first(where: { $0.name == name })?.value
        }
        switch action {
        case "open":
            guard let target = query("url"), let url = URL(string: target) else { return false }
            return receive(url: url, needsConfirmation: true)
        case "prompt":
            guard let prompt = query("prompt") else { return false }
            return receive(
                prompt: prompt,
                xSuccess: Self.callbackURL(query("x-success")),
                xError: Self.callbackURL(query("x-error")),
                xCancel: Self.callbackURL(query("x-cancel")))
        default:
            return false
        }
    }

    
    @discardableResult
    func receive(
        prompt raw: String, xSuccess: URL?, xError: URL?, xCancel: URL?,
        needsConfirmation: Bool = true, now: Date = Date()
    ) -> Bool {
        let prompt = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.count <= Self.maxPromptLength else { return false }
        
        
        if let last = lastPromptAccepted, last.prompt == prompt,
            now.timeIntervalSince(last.at) < Self.dedupWindow
        {
            return true
        }
        lastPromptAccepted = (prompt, now)
        pendingPrompt = PendingPrompt(
            id: UUID(), prompt: prompt, xSuccess: xSuccess, xError: xError, xCancel: xCancel,
            needsConfirmation: needsConfirmation, receivedAt: now)
        return true
    }

    
    
    
    func runIntentPrompt(_ text: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            guard
                receive(
                    prompt: text, xSuccess: nil, xError: nil, xCancel: nil,
                    needsConfirmation: false)
            else {
                continuation.resume(throwing: InboundActionError.invalidPrompt)
                return
            }
            guard let id = pendingPrompt?.id else {
                
                continuation.resume(throwing: InboundActionError.busy)
                return
            }
            resultContinuations[id] = continuation
        }
    }

    
    func runTranscriptRequest() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let request = PendingTranscript(id: UUID(), receivedAt: Date())
            pendingTranscript = request
            resultContinuations[request.id] = continuation
        }
    }

    
    func resolve(id: UUID, with result: Result<String, Error>) {
        resultContinuations.removeValue(forKey: id)?.resume(with: result)
    }

    
    
    
    func drainShareInbox(_ inbox: AppGroupInbox = AppGroupInbox()) {
        for request in inbox.drain() {
            _ = receive(url: request.url, needsConfirmation: true)
        }
    }

    func consume(transcript request: PendingTranscript) {
        if pendingTranscript?.id == request.id { pendingTranscript = nil }
    }

    
    
    @discardableResult
    func receive(selecting scoopJid: String, now: Date = Date()) -> Bool {
        let jid = scoopJid.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !jid.isEmpty, jid.count <= Self.maxJidLength else { return false }
        pendingSelection = PendingSelection(id: UUID(), scoopJid: jid, receivedAt: now)
        return true
    }

    func consume(selection: PendingSelection) {
        if pendingSelection?.id == selection.id { pendingSelection = nil }
    }

    
    
    
    @discardableResult
    func receive(appLink: URL) -> Bool {
        guard let components = URLComponents(url: appLink, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == "https",
            let host = components.host?.lowercased(),
            host == "sliccy.ai" || host == "www.sliccy.ai",
            components.path.hasPrefix("/app/")
        else { return false }
        let action = components.path.dropFirst("/app/".count).lowercased()
        func query(_ name: String) -> String? {
            components.queryItems?.first(where: { $0.name == name })?.value
        }
        switch action {
        case "open":
            guard let target = query("url"), let url = URL(string: target) else { return false }
            return receive(url: url, needsConfirmation: true)
        case "prompt":
            guard let prompt = query("prompt") else { return false }
            return receive(
                prompt: prompt,
                xSuccess: Self.callbackURL(query("x-success")),
                xError: Self.callbackURL(query("x-error")),
                xCancel: Self.callbackURL(query("x-cancel")))
        default:
            return false
        }
    }

    
    
    func consume(_ action: PendingOpen) {
        if pendingOpen?.id == action.id { pendingOpen = nil }
    }

    func consume(prompt action: PendingPrompt) {
        if pendingPrompt?.id == action.id { pendingPrompt = nil }
    }

    
    
    
    static func callbackURL(_ raw: String?) -> URL? {
        guard let raw, raw.count <= maxURLLength, let url = URL(string: raw),
            let scheme = url.scheme?.lowercased(),
            scheme != "http", scheme != "https", scheme != "slicc"
        else { return nil }
        return url
    }

    
    
    
    static func validated(_ url: URL) -> URL? {
        guard url.absoluteString.count <= maxURLLength,
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            components.user == nil, components.password == nil,
            let host = components.host, !host.isEmpty
        else { return nil }
        return url
    }
}








enum InboundSelectionRule {

    
    
    
    
    
    
    
    enum Outcome: Equatable {
        
        case select
        
        case wait
        
        
        case drop
    }

    
    
    
    
    
    
    static let maximumAge: TimeInterval = 120

    static func outcome(forSelecting jid: String, roster: [String], age: TimeInterval) -> Outcome {
        if roster.contains(jid) { return .select }
        if age > maximumAge { return .drop }
        
        
        
        return roster.isEmpty ? .wait : .drop
    }
}



enum InboundActionError: Error, LocalizedError {
    case invalidPrompt
    case busy
    case notConnected
    case timedOut
    case cancelled
    case agent(String)

    var errorDescription: String? {
        switch self {
        case .invalidPrompt: return "The prompt is empty or too long."
        case .busy: return "Sliccy is already waiting on another automation request."
        case .notConnected: return "Sliccy is not connected to a leader."
        case .timedOut: return "Timed out waiting for the reply."
        case .cancelled: return "The request was dismissed."
        case .agent(let message): return message
        }
    }
}












@MainActor
final class InboundPromptWaiter {
    enum Outcome {
        case reply(String)
        case failure(String)
    }

    private var armed: (token: UUID, scoopJid: String, settle: (Outcome) -> Void)?

    @discardableResult
    func arm(scoopJid: String, settle: @escaping (Outcome) -> Void) -> UUID {
        let token = UUID()
        armed = (token, scoopJid, settle)
        return token
    }

    
    
    @discardableResult
    func timeout(token: UUID) -> Bool {
        guard let waiter = armed, waiter.token == token else { return false }
        armed = nil
        waiter.settle(.failure("Timed out waiting for the reply"))
        return true
    }

    func settle(with replyText: String, scoopJid: String) {
        guard let waiter = armed, waiter.scoopJid == scoopJid else { return }
        armed = nil
        waiter.settle(.reply(replyText))
    }

    func fail(scoopJid: String, error: String) {
        guard let waiter = armed, waiter.scoopJid == scoopJid else { return }
        armed = nil
        waiter.settle(.failure(error))
    }
}






@MainActor
final class InboundSnapshotWaiter {
    private var armed: (token: UUID, scoopJid: String, settle: () -> Void)?

    @discardableResult
    func arm(scoopJid: String, settle: @escaping () -> Void) -> UUID {
        let token = UUID()
        armed = (token, scoopJid, settle)
        return token
    }

    @discardableResult
    func timeout(token: UUID) -> Bool {
        guard armed?.token == token else { return false }
        armed = nil
        return true
    }

    func settle(scoopJid: String?) {
        guard let waiter = armed, waiter.scoopJid == scoopJid ?? waiter.scoopJid else { return }
        armed = nil
        waiter.settle()
    }
}
