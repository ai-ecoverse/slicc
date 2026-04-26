import Foundation

/// Manages session-scoped secret masking and injection for the fetch proxy.
///
/// On initialization, loads all secrets from the Keychain and generates
/// deterministic masked values for the current session. The fetch proxy
/// uses this to:
/// 1. Replace masked values → real values in outbound requests (with domain checks)
/// 2. Replace real values → masked values in inbound responses
///
/// Call `reload()` after secret mutations (POST/DELETE) to pick up changes
/// while keeping the same session ID for stable masked values.
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

    /// The session ID used for masking. Kept stable across reloads.
    private let sessionId: String?

    /// Secrets loaded from an env file that override/supplement Keychain secrets.
    private let _envFileSecrets: [Secret]

    private let lock = NSLock()
    private nonisolated(unsafe) var _secrets: [LoadedSecret]
    private nonisolated(unsafe) var _responseScrubber: @Sendable (String) -> String

    private var secrets: [LoadedSecret] {
        lock.lock()
        defer { lock.unlock() }
        return _secrets
    }

    private var responseScrubber: @Sendable (String) -> String {
        lock.lock()
        defer { lock.unlock() }
        return _responseScrubber
    }

    private func setSecretsAndScrubber(secrets: [LoadedSecret], scrubber: @Sendable @escaping (String) -> String) {
        lock.lock()
        defer { lock.unlock() }
        _secrets = secrets
        _responseScrubber = scrubber
    }

    /// Initialize with an explicit list of loaded secrets (for testing).
    init(secrets: [LoadedSecret]) {
        self.sessionId = nil
        self._envFileSecrets = []
        self._secrets = secrets
        let pairs = secrets.map { SecretPair(realValue: $0.realValue, maskedValue: $0.maskedValue) }
        self._responseScrubber = buildScrubber(secrets: pairs)
    }

    /// Initialize by loading all secrets from the Keychain and masking them
    /// with the given session ID. Optional `envFileSecrets` are merged in
    /// and override Keychain entries with the same name.
    init(sessionId: String, envFileSecrets: [Secret] = []) {
        self.sessionId = sessionId
        self._envFileSecrets = envFileSecrets
        self._secrets = []
        self._responseScrubber = { $0 }
        loadSecrets()
    }

    /// Reload secrets from the Keychain (and env file overrides), keeping
    /// the same session ID. Call this after secret mutations (POST/DELETE)
    /// so the injector picks up added/removed secrets.
    func reload() {
        loadSecrets()
    }

    private func loadSecrets() {
        guard let sessionId else { return }
        // Single Keychain read + parse for every secret. Previously this did
        // SecretStore.list() followed by per-name SecretStore.get(...), which
        // re-parsed the same blob N+1 times.
        var loaded: [LoadedSecret] = []
        for secret in SecretStore.all() {
            let masked = mask(sessionId: sessionId, secretName: secret.name, realValue: secret.value)
            loaded.append(LoadedSecret(
                name: secret.name,
                realValue: secret.value,
                maskedValue: masked,
                domains: secret.domains
            ))
        }

        // Merge env-file secrets: override existing by name, append new ones
        for secret in _envFileSecrets {
            let masked = mask(sessionId: sessionId, secretName: secret.name, realValue: secret.value)
            let entry = LoadedSecret(
                name: secret.name,
                realValue: secret.value,
                maskedValue: masked,
                domains: secret.domains
            )
            if let idx = loaded.firstIndex(where: { $0.name == secret.name }) {
                loaded[idx] = entry
            } else {
                loaded.append(entry)
            }
        }

        let pairs = loaded.map { SecretPair(realValue: $0.realValue, maskedValue: $0.maskedValue) }
        setSecretsAndScrubber(secrets: loaded, scrubber: buildScrubber(secrets: pairs))
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

    /// Inject real values into text destined for an upstream request (headers).
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

    /// Inject real values into request body text.
    ///
    /// Unlike `inject(text:hostname:)`, when the domain does NOT match,
    /// the masked value is left as-is (not rejected). This is safe because
    /// the masked value is meaningless — it's typically conversation context
    /// sent to an LLM API like Bedrock.
    func injectBody(text: String, hostname: String) -> String {
        var result = text
        for secret in secrets {
            guard result.contains(secret.maskedValue) else { continue }
            guard isAllowedDomain(patterns: secret.domains, hostname: hostname) else {
                // Leave the masked value as-is — do not reject, do not unmask
                continue
            }
            result = result.replacingOccurrences(of: secret.maskedValue, with: secret.realValue)
        }
        return result
    }

    /// Scrub real secret values from response text, replacing with masked equivalents.
    func scrub(text: String) -> String {
        responseScrubber(text)
    }
}

