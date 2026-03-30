import Foundation

/// Manages session-scoped secret masking and injection for the fetch proxy.
///
/// On initialization, loads all secrets from the Keychain and generates
/// deterministic masked values for the current session. The fetch proxy
/// uses this to:
/// 1. Replace masked values → real values in outbound requests (with domain checks)
/// 2. Replace real values → masked values in inbound responses
public final class SecretInjector: Sendable {

    /// A loaded secret with its masked counterpart.
    struct LoadedSecret: Sendable {
        let name: String
        let realValue: String
        let maskedValue: String
        let domains: [String]
    }

    /// Result of attempting to inject secrets into a request.
    enum InjectionResult: Sendable {
        /// All masked values were successfully replaced with real values.
        case success(text: String)
        /// A masked value was found but the target domain is not allowed.
        case domainBlocked(secretName: String, hostname: String)
    }

    private let secrets: [LoadedSecret]
    private let responseScrubber: @Sendable (String) -> String

    /// Initialize with an explicit list of loaded secrets (for testing).
    init(secrets: [LoadedSecret]) {
        self.secrets = secrets
        let pairs = secrets.map { SecretPair(realValue: $0.realValue, maskedValue: $0.maskedValue) }
        self.responseScrubber = buildScrubber(secrets: pairs)
    }

    /// Initialize by loading all secrets from the Keychain and masking them
    /// with the given session ID.
    convenience init(sessionId: String) {
        let entries = SecretStore.list()
        var loaded: [LoadedSecret] = []
        for entry in entries {
            guard let secret = SecretStore.get(name: entry.name) else { continue }
            let masked = mask(sessionId: sessionId, secretName: secret.name, realValue: secret.value)
            loaded.append(LoadedSecret(
                name: secret.name,
                realValue: secret.value,
                maskedValue: masked,
                domains: secret.domains
            ))
        }
        self.init(secrets: loaded)
    }

    /// Returns true if there are no secrets loaded.
    var isEmpty: Bool { secrets.isEmpty }

    /// Returns masked environment variables for the agent's shell.
    /// Each secret becomes `name → maskedValue`.
    var maskedEnvironment: [String: String] {
        var env: [String: String] = [:]
        for s in secrets {
            env[s.name] = s.maskedValue
        }
        return env
    }

    /// Returns masked entries with name, maskedValue, and domains for the /api/secrets/masked endpoint.
    var maskedEntries: [(name: String, maskedValue: String, domains: [String])] {
        secrets.map { (name: $0.name, maskedValue: $0.maskedValue, domains: $0.domains) }
    }

    /// Inject real values into text destined for an upstream request.
    ///
    /// Scans `text` for any known masked values. For each match:
    /// - Validates the target `hostname` against the secret's domain allowlist.
    /// - If allowed, replaces masked → real.
    /// - If not allowed, returns `.domainBlocked` immediately.
    func inject(text: String, hostname: String) -> InjectionResult {
        var result = text
        for secret in secrets {
            guard result.contains(secret.maskedValue) else { continue }
            guard isAllowedDomain(patterns: secret.domains, hostname: hostname) else {
                return .domainBlocked(secretName: secret.name, hostname: hostname)
            }
            result = result.replacingOccurrences(of: secret.maskedValue, with: secret.realValue)
        }
        return .success(text: result)
    }

    /// Scrub real secret values from response text, replacing with masked equivalents.
    func scrub(text: String) -> String {
        responseScrubber(text)
    }
}

