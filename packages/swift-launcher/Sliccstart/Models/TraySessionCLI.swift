import Foundation
import SliccTraySession
















enum TraySessionCLI {
    
    
    struct Request: Equatable {
        var reveal: Bool
    }

    static let listFlag = "--list-sessions"
    static let revealFlag = "--reveal-urls"

    
    
    static func parse(_ argv: [String]) -> Request? {
        let args = argv.dropFirst()
        guard args.contains(listFlag) else { return nil }
        return Request(reveal: args.contains(revealFlag))
    }

    
    
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

    

    
    enum StoredConsent: String {
        case allow
        case deny
    }

    
    enum Outcome: Equatable {
        case allow
        case deny
        case prompt
    }

    
    
    
    
    static func outcome(stored: StoredConsent?, guiAvailable: Bool) -> Outcome {
        switch stored {
        case .allow: return .allow
        case .deny: return .deny
        case nil: return guiAvailable ? .prompt : .deny
        }
    }

    
    enum PromptResult: Equatable {
        case denyOnce
        case allowOnce
        case alwaysAllow
        case alwaysDeny
    }

    static let buttonTitles = ["Deny", "Allow Once", "Always Allow", "Always Deny"]

    
    
    static func promptResult(forButtonIndex index: Int) -> PromptResult {
        switch index {
        case 1001: return .allowOnce
        case 1002: return .alwaysAllow
        case 1003: return .alwaysDeny
        default: return .denyOnce
        }
    }

    
    static func effect(of result: PromptResult) -> (allow: Bool, persist: StoredConsent?) {
        switch result {
        case .allowOnce: return (true, nil)
        case .denyOnce: return (false, nil)
        case .alwaysAllow: return (true, .allow)
        case .alwaysDeny: return (false, .deny)
        }
    }

    
    
    
    
    
    static func consentKey(signingIdentifier: String?, executablePath: String?) -> String {
        if let signing = signingIdentifier, !signing.isEmpty { return "id:" + signing }
        if let path = executablePath, !path.isEmpty { return "path:" + path }
        return "unknown"
    }

    
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
        
        
        
        
        return """
            Revealing session join URLs requires approval, which cannot be shown over \
            a headless/SSH session. Re-run this same command from the Mac's screen \
            (e.g. in Terminal.app on the Mac itself) and choose "Always Allow".

            """
    }
}




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
