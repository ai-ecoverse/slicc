import Foundation
import SwiftUI

/// Single app-owned funnel for inbound actions (#1918): App Intents, deep
/// links, and any future App Group handoff all enter here so the entry
/// points cannot drift. Validation and normalization happen before anything
/// is enqueued; SwiftUI observes the one pending slot.
@MainActor
final class InboundActionCoordinator: ObservableObject {

    /// One instance for the whole process: `onOpenURL` and App Intents
    /// both run in-app and must land in the same queue the UI observes.
    static let shared = InboundActionCoordinator()

    /// A validated request to open a URL in the local browser.
    /// `needsConfirmation` distinguishes an explicit in-app user action
    /// (an App Intent the user just invoked) from a deep link, which is
    /// untrusted input — a received URL is not authorization (#1918).
    struct PendingOpen: Identifiable, Equatable {
        let id: UUID
        let url: URL
        let needsConfirmation: Bool
        let receivedAt: Date
    }

    @Published private(set) var pendingOpen: PendingOpen?

    /// A validated automation prompt (`slicc://prompt` / the x-callback-url
    /// form). Always confirmed in-app before anything reaches the leader —
    /// a deep-linked prompt can trigger agent tools, so the default is
    /// fail-closed until the user says Send (#1918).
    struct PendingPrompt: Identifiable, Equatable {
        let id: UUID
        let prompt: String
        let xSuccess: URL?
        let xError: URL?
        let xCancel: URL?
        /// Deep-linked prompts confirm in-app; an App Intent the user just
        /// invoked is already the explicit action.
        let needsConfirmation: Bool
        let receivedAt: Date
    }

    @Published private(set) var pendingPrompt: PendingPrompt?

    /// A transcript export request (the Get Current Conversation intent).
    struct PendingTranscript: Identifiable, Equatable {
        let id: UUID
        let receivedAt: Date
    }

    @Published private(set) var pendingTranscript: PendingTranscript?

    /// A request to bring one work unit to the front (the Open Conversation
    /// intent). Carries only the jid: whether that unit is still in the
    /// leader's scoop list is the shell's call, because the entity Siri
    /// resolved comes from a widget snapshot that may predate the current
    /// list — and this coordinator deliberately holds no leader state.
    struct PendingSelection: Identifiable, Equatable {
        let id: UUID
        let scoopJid: String
        let receivedAt: Date
    }

    @Published private(set) var pendingSelection: PendingSelection?

    /// Coarse lifecycle for the surfaces: what the funnel is doing right
    /// now, so SwiftUI can show progress and tests can assert transitions
    /// (#1918 "expose pending/approved/running/completed/failed").
    enum Phase: Equatable {
        case running(String)
        case failed(String)
    }

    @Published var phase: Phase?

    /// Intent continuations keyed by pending-action id: the App Intent
    /// awaits here while the shell executes and settles. One-shot.
    private var resultContinuations: [UUID: CheckedContinuation<String, Error>] = [:]

    static let maxPromptLength = 8192
    static let maxTranscriptBytes = 512 * 1024
    /// A jid is a leader-minted identifier, not free text. Bounded for the
    /// same reason the URL is: an intent parameter is still input.
    static let maxJidLength = 256

    /// Replay guard: the same URL arriving again within the window is a
    /// Shortcuts/share-sheet retry, not new intent.
    private var lastAccepted: (url: URL, at: Date)?
    private var lastPromptAccepted: (prompt: String, at: Date)?

    static let maxURLLength = 2048
    private static let dedupWindow: TimeInterval = 3

    /// Validate and enqueue. Returns false when the URL is rejected —
    /// callers surface that as an explicit error, never silence.
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

    /// The deep-link routes. Short form uses the host as the action
    /// (`slicc://open?url=…`, `slicc://prompt?prompt=…`); the
    /// x-callback-url convention nests the action in the path
    /// (`slicc://x-callback-url/prompt?prompt=…&x-success=…`) so
    /// automation apps like Shortcuts can round-trip a result. Everything
    /// arriving here requires visible confirmation before executing.
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

    /// Validate and enqueue an automation prompt.
    @discardableResult
    func receive(
        prompt raw: String, xSuccess: URL?, xError: URL?, xCancel: URL?,
        needsConfirmation: Bool = true, now: Date = Date()
    ) -> Bool {
        let prompt = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.count <= Self.maxPromptLength else { return false }
        // Same replay guard as opens: an identical prompt within the
        // window is a Shortcuts retry, not new intent.
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

    /// Intent-facing prompt: enqueue without a second confirmation and
    /// await the reply. The continuation resolves when the shell settles
    /// the turn (or fails/dismisses it).
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
                // Dedup swallowed it — a retry of a prompt already running.
                continuation.resume(throwing: InboundActionError.busy)
                return
            }
            resultContinuations[id] = continuation
        }
    }

    /// Intent-facing transcript request; resolves with rendered Markdown.
    func runTranscriptRequest() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let request = PendingTranscript(id: UUID(), receivedAt: Date())
            pendingTranscript = request
            resultContinuations[request.id] = continuation
        }
    }

    /// Resolve an intent continuation (no-op for card-only actions).
    func resolve(id: UUID, with result: Result<String, Error>) {
        resultContinuations.removeValue(forKey: id)?.resume(with: result)
    }

    /// Surface whatever the Share extension parked while we were away.
    /// Deferred consumption always confirms — the share tap happened in
    /// another app, possibly a while ago (#1918).
    func drainShareInbox(_ inbox: AppGroupInbox = AppGroupInbox()) {
        for request in inbox.drain() {
            _ = receive(url: request.url, needsConfirmation: true)
        }
    }

    func consume(transcript request: PendingTranscript) {
        if pendingTranscript?.id == request.id { pendingTranscript = nil }
    }

    /// Validate and enqueue a unit selection. Rejects an empty or oversized
    /// jid; existence is checked downstream, where the scoop list lives.
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

    /// The universal-link route (#1918): `https://(www.)sliccy.ai/app/open`
    /// and `/app/prompt` carry the same query contract as the slicc://
    /// scheme. A link is a link — everything here confirms in-app.
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

    /// Take the action out of the slot (about to execute or dismiss). The
    /// id check keeps a stale card from consuming a newer request.
    func consume(_ action: PendingOpen) {
        if pendingOpen?.id == action.id { pendingOpen = nil }
    }

    func consume(prompt action: PendingPrompt) {
        if pendingPrompt?.id == action.id { pendingPrompt = nil }
    }

    /// Caller-supplied x-callback destinations must be custom-scheme URLs
    /// (`shortcuts://…` and friends): http(s) would turn a callback into a
    /// web redirect, and our own scheme would loop. Bounded, never logged.
    static func callbackURL(_ raw: String?) -> URL? {
        guard let raw, raw.count <= maxURLLength, let url = URL(string: raw),
            let scheme = url.scheme?.lowercased(),
            scheme != "http", scheme != "https", scheme != "slicc"
        else { return nil }
        return url
    }

    /// HTTP(S) only, no embedded credentials, bounded length. Custom
    /// schemes belong to the approval-gated external-open capability
    /// (#1917), never to this path.
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

// MARK: - InboundSelectionRule

/// Whether a pending conversation selection can be resolved yet.
///
/// A free function rather than a method on the coordinator: it is pure, it is
/// the interesting part, and it has no business requiring the main actor to be
/// asked a question about two arrays. Same split as `BrowserTargets`.
enum InboundSelectionRule {

    /// The distinction this exists to make: "the leader has no such unit" and
    /// "the leader has not told us its units yet" are different answers, and
    /// the second one is the COMMON case. `OpenSliccConversationIntent` sets
    /// `openAppWhenRun`, so a Spotlight or Siri hit launches the app cold —
    /// `scoops` is empty (and `handleDisconnect` resets it to empty) until the
    /// first `scoops.list` lands. Treating that emptiness as "not found" drops
    /// the request the user just made, on the path they will use most.
    enum Outcome: Equatable {
        /// The roster has the unit — select it.
        case select
        /// The roster has not arrived yet; stay armed for the next one.
        case wait
        /// The leader has spoken and the unit is not there (or the request is
        /// too old to still be what the user wants) — give up.
        case drop
    }

    /// How long a selection stays armed waiting for a roster.
    ///
    /// Generous next to a dial (seconds), short next to "the user wandered
    /// off". Without it, a request made before a leader was ever reachable
    /// would fire whenever one eventually connected, which reads as the app
    /// jumping somewhere on its own.
    static let maximumAge: TimeInterval = 120

    static func outcome(forSelecting jid: String, roster: [String], age: TimeInterval) -> Outcome {
        if roster.contains(jid) { return .select }
        if age > maximumAge { return .drop }
        // A non-empty roster IS the leader's full answer, so absence from it
        // is authoritative — that is the "the scoop ended" case, where staying
        // put beats yanking the user to a unit that is gone.
        return roster.isEmpty ? .wait : .drop
    }
}

// MARK: - Errors

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

// MARK: - InboundPromptWaiter

/// One-shot waiter armed by an approved `slicc://prompt` request. Settles
/// with the first assistant reply that completes on the armed scoop
/// (content_done or turn_end, whichever lands first — leaders disagree,
/// exactly like `speakIfDictated`), or the agent's error. Consuming on
/// first settle keeps the double hook safe. Lives outside `AppState`'s
/// size-capped type body; `AppState` owns one and calls in from its event
/// arms. WIP caveat: binds to the next completed reply on the scoop, not
/// yet to the specific submitted message (#1918 asks for strict
/// correlation).
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

    /// Settle only the arm that scheduled this timeout. A later request may
    /// have replaced it while the timeout task was sleeping.
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

// MARK: - InboundSnapshotWaiter

/// One-shot waiter for a fresh leader snapshot: the transcript intent must
/// not export stale in-memory rows, so it re-requests and waits for the
/// `.snapshot` arm to land for the armed scoop (#1918).
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
