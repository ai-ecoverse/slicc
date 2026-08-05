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

    /// The `slicc://open?url=…` deep-link route. Always requires visible
    /// confirmation before anything opens.
    @discardableResult
    func receive(deepLink: URL) -> Bool {
        guard deepLink.scheme?.lowercased() == "slicc",
            deepLink.host()?.lowercased() == "open",
            let components = URLComponents(url: deepLink, resolvingAgainstBaseURL: false),
            let target = components.queryItems?.first(where: { $0.name == "url" })?.value,
            let url = URL(string: target)
        else { return false }
        return receive(url: url, needsConfirmation: true)
    }

    /// Take the action out of the slot (about to execute or dismiss). The
    /// id check keeps a stale card from consuming a newer request.
    func consume(_ action: PendingOpen) {
        if pendingOpen?.id == action.id { pendingOpen = nil }
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
