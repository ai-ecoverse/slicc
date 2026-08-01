import Foundation
import SliccTraySession

/// Headless `Sliccstart --list-sessions` support.
///
/// The launcher's iCloud key-value store holds active tray *join URLs*, which
/// are bearer secrets: whoever holds one can attach as a follower and run
/// commands on the leader. Listing the sessions is therefore split in two:
///
/// - **metadata** (opaque `id`, `label`, device, timestamps) is the user's own
///   non-secret data and prints freely, so `slicc list-sessions` and pipelines
///   never leak a token by accident;
/// - the raw **join URL** is emitted only with `--reveal-urls`, behind a consent
///   gate (see `TraySessionCLIRunner`).
///
/// Everything here is pure so it is unit-tested without touching iCloud, AppKit,
/// or `UserDefaults`; the untestable glue (NSAlert, caller identity, the real
/// store read) lives in `TraySessionCLIRunner`.
enum TraySessionCLI {
    /// A parsed headless invocation. `parse` returns `nil` for a normal GUI
    /// launch so `main` falls through to the SwiftUI app.
    struct Request: Equatable {
        var reveal: Bool
    }

    static let listFlag = "--list-sessions"
    static let revealFlag = "--reveal-urls"

    /// Recognise `--list-sessions [--reveal-urls]` anywhere in the process
    /// arguments (argv[0] is the executable path). Any other launch returns nil.
    static func parse(_ argv: [String]) -> Request? {
        let args = argv.dropFirst()
        guard args.contains(listFlag) else { return nil }
        return Request(reveal: args.contains(revealFlag))
    }

    /// Wire shape shared with the Go CLI (`internal/cloud`). `joinUrl` is present
    /// only when revealed; ISO-8601 dates keep it trivially parseable in Go.
    struct SessionDTO: Codable, Equatable {
        let id: String
        let label: String
        let deviceId: String
        let deviceName: String
        let createdAt: Date
        let lastSeenAt: Date
        let joinUrl: String?
    }

    static func payload(from sessions: [SyncedTraySession], reveal: Bool) -> [SessionDTO] {
        sessions.map {
            SessionDTO(
                id: $0.id,
                label: $0.label,
                deviceId: $0.deviceId,
                deviceName: $0.deviceName,
                createdAt: $0.createdAt,
                lastSeenAt: $0.lastSeenAt,
                joinUrl: reveal ? $0.joinUrl : nil
            )
        }
    }

    static func encode(_ sessions: [SyncedTraySession], reveal: Bool) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(payload(from: sessions, reveal: reveal))
    }

    // MARK: - Reveal consent

    /// A persisted "always" decision for a given caller identity.
    enum StoredConsent: String {
        case allow
        case deny
    }

    /// What to do for a reveal request before any interactive prompt.
    enum Outcome: Equatable {
        case allow
        case deny
        case prompt
    }

    /// Non-interactive resolution: a remembered "always" wins; otherwise prompt
    /// when a GUI session exists, and deny outright when it does not (so a
    /// headless/SSH caller cannot silently harvest tokens — the user must grant
    /// once from the Mac's screen).
    static func outcome(stored: StoredConsent?, guiAvailable: Bool) -> Outcome {
        switch stored {
        case .allow: return .allow
        case .deny: return .deny
        case nil: return guiAvailable ? .prompt : .deny
        }
    }

    /// The four consent-dialog buttons, in presentation order.
    enum PromptResult: Equatable {
        case denyOnce
        case allowOnce
        case alwaysAllow
        case alwaysDeny
    }

    static let buttonTitles = ["Deny", "Allow Once", "Always Allow", "Always Deny"]

    /// Map an `NSAlert.runModal()` response to a decision. The first button is
    /// `alertFirstButtonReturn` (1000) and each subsequent button increments.
    static func promptResult(forButtonIndex index: Int) -> PromptResult {
        switch index {
        case 1001: return .allowOnce
        case 1002: return .alwaysAllow
        case 1003: return .alwaysDeny
        default: return .denyOnce
        }
    }

    /// Whether the request is allowed now, and any "always" decision to persist.
    static func effect(of result: PromptResult) -> (allow: Bool, persist: StoredConsent?) {
        switch result {
        case .allowOnce: return (true, nil)
        case .denyOnce: return (false, nil)
        case .alwaysAllow: return (true, .allow)
        case .alwaysDeny: return (false, .deny)
        }
    }

    /// Persistence/identity key for a caller. A code-signing identifier is
    /// stable across paths and hard to forge, so it is preferred; the
    /// executable path is a best-effort fallback. Both are spoofable by code
    /// already running as the user, so this keys "always" decisions rather than
    /// forming a real trust boundary.
    static func consentKey(signingIdentifier: String?, executablePath: String?) -> String {
        if let signing = signingIdentifier, !signing.isEmpty { return "id:" + signing }
        if let path = executablePath, !path.isEmpty { return "path:" + path }
        return "unknown"
    }

    /// Human-facing description of the requesting process for the dialog.
    static func describeCaller(name: String?, pid: Int32, signingIdentifier: String?) -> String {
        let label = (name?.isEmpty == false) ? name! : "An unidentified process"
        var description = "\(label) (pid \(pid))"
        if let signing = signingIdentifier, !signing.isEmpty {
            description += ", signed by \(signing)"
        }
        return description
    }

    static func deniedMessage(guiAvailable: Bool) -> String {
        if guiAvailable {
            return "Revealing session join URLs was denied.\n"
        }
        // The remembered "Always Allow" is keyed to the requesting caller, so the
        // grant must be made by re-running the SAME command from the Mac's screen
        // (not by launching Sliccstart directly, which is a different caller and
        // would not authorize this one).
        return """
            Revealing session join URLs requires approval, which cannot be shown over \
            a headless/SSH session. Re-run this same command from the Mac's screen \
            (e.g. in Terminal.app on the Mac itself) and choose "Always Allow".

            """
    }
}

/// `UserDefaults`-backed record of "Always Allow"/"Always Deny" reveal
/// decisions, keyed by caller identity. Small enough to unit-test with an
/// injected suite.
struct RevealConsentStore {
    static let keyPrefix = "traySessionRevealConsent."

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load(forConsentKey consentKey: String) -> TraySessionCLI.StoredConsent? {
        guard let raw = defaults.string(forKey: Self.keyPrefix + consentKey) else { return nil }
        return TraySessionCLI.StoredConsent(rawValue: raw)
    }

    func save(_ consent: TraySessionCLI.StoredConsent, forConsentKey consentKey: String) {
        defaults.set(consent.rawValue, forKey: Self.keyPrefix + consentKey)
    }
}
