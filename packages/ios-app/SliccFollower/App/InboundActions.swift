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
        let receivedAt: Date
    }

    @Published private(set) var pendingPrompt: PendingPrompt?

    static let maxPromptLength = 8192

    /// Replay guard: the same URL arriving again within the window is a
    /// Shortcuts/share-sheet retry, not new intent.
    private var lastAccepted: (url: URL, at: Date)?

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
        prompt raw: String, xSuccess: URL?, xError: URL?, xCancel: URL?, now: Date = Date()
    ) -> Bool {
        let prompt = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.count <= Self.maxPromptLength else { return false }
        pendingPrompt = PendingPrompt(
            id: UUID(), prompt: prompt, xSuccess: xSuccess, xError: xError, xCancel: xCancel,
            receivedAt: now)
        return true
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

    private var armed: (scoopJid: String, settle: (Outcome) -> Void)?

    func arm(scoopJid: String, settle: @escaping (Outcome) -> Void) {
        armed = (scoopJid, settle)
    }

    /// Settle as timed out if still armed; the waiter otherwise won.
    func timeout() {
        guard let waiter = armed else { return }
        armed = nil
        waiter.settle(.failure("Timed out waiting for the reply"))
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
