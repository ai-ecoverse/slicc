import Foundation

public enum OptelEnvConfig {

    public static let rateKey = "OPTEL_RATE"

    public static let debugKey = "OPTEL_DEBUG"

    public static func resolveRate(
        explicit: String?,
        environment: [String: String]
    ) -> String? {
        if let envRate = environment[rateKey], !envRate.isEmpty {
            return envRate
        }
        return explicit
    }

    public static func resolveDebugLogging(environment: [String: String]) -> Bool {
        guard let value = environment[debugKey] else { return false }
        switch value.lowercased() {
        case "1", "true", "on", "yes": return true
        default: return false
        }
    }
}
