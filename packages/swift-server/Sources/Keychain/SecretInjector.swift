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

    /// Info about a domain-blocked secret, mirrors TS `ForbiddenInfo`.
    struct ForbiddenInfo: Sendable, Equatable {
        let secretName: String
        let hostname: String
    }

    /// Result of `unmaskAuthorizationBasic` — either an updated header value,
    /// or a forbidden block. Mirrors TS `BasicResult`.
    struct BasicResult: Sendable, Equatable {
        let value: String
        let forbidden: ForbiddenInfo?
    }

    /// Result of `extractAndUnmaskUrlCredentials`. Mirrors TS `ExtractedUrlCreds`.
    struct ExtractedUrlCreds: Sendable, Equatable {
        let url: String
        let syntheticAuthorization: String?
        let forbidden: ForbiddenInfo?
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

    // MARK: - Basic-auth / URL-credential / byte-safe helpers (Phase 2 parity)

    /// Mirrors TS `SecretsPipeline.unmaskAuthorizationBasic`.
    ///
    /// Matches `^Basic\s+(.+)$`, base64-decodes the payload, then scans the
    /// `user:pass` halves for known masked values. If any masked value is
    /// present:
    /// - and its domain allowlist matches `targetHostname`, the masked half
    ///   is unmasked and the header is re-encoded as `Basic base64(user:pass)`.
    /// - and the domain does NOT match, returns a `.forbidden` result.
    ///
    /// Notes vs TS:
    /// - `Data(base64Encoded:)` is stricter than `atob()` about padding /
    ///   whitespace. The TS `atob` happily accepts unpadded base64; Foundation
    ///   requires padding. We try the input as-is first, then fall back to
    ///   appending `=` padding to match `atob` semantics. Whitespace-tolerant
    ///   decoding is enabled via `.ignoreUnknownCharacters` so values like
    ///   `Basic   <b64>` (multiple spaces) work the same way as the TS path.
    /// - `Data.base64EncodedString()` matches `btoa()` for ASCII inputs.
    func unmaskAuthorizationBasic(value: String, targetHostname: String) -> BasicResult {
        // ^Basic\s+(.+)$ — same regex shape as TS pipeline.
        let trimmedHeader = value
        guard let match = trimmedHeader.range(
            of: #"^Basic\s+(.+)$"#,
            options: .regularExpression
        ), match.lowerBound == trimmedHeader.startIndex else {
            return BasicResult(value: value, forbidden: nil)
        }
        let payload = String(trimmedHeader[match])
            .dropFirst("Basic".count)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard let decoded = decodeBase64ToString(String(payload)) else {
            return BasicResult(value: value, forbidden: nil)
        }
        // Find first `:` — same as TS `decoded.indexOf(':')`.
        guard let colonIdx = decoded.firstIndex(of: ":") else {
            return BasicResult(value: value, forbidden: nil)
        }
        var user = String(decoded[..<colonIdx])
        var pass = String(decoded[decoded.index(after: colonIdx)...])
        var touched = false
        for secret in secrets {
            let inUser = user.contains(secret.maskedValue)
            let inPass = pass.contains(secret.maskedValue)
            guard inUser || inPass else { continue }
            guard isAllowedDomain(patterns: secret.domains, hostname: targetHostname) else {
                return BasicResult(
                    value: value,
                    forbidden: ForbiddenInfo(secretName: secret.name, hostname: targetHostname)
                )
            }
            if inUser { user = user.replacingOccurrences(of: secret.maskedValue, with: secret.realValue) }
            if inPass { pass = pass.replacingOccurrences(of: secret.maskedValue, with: secret.realValue) }
            touched = true
        }
        if !touched { return BasicResult(value: value, forbidden: nil) }
        let combined = "\(user):\(pass)"
        let reencoded = Data(combined.utf8).base64EncodedString()
        return BasicResult(value: "Basic \(reencoded)", forbidden: nil)
    }

    /// Mirrors TS `SecretsPipeline.extractAndUnmaskUrlCredentials`.
    ///
    /// Parses the URL, extracts `username`/`password`, runs the same
    /// masked→real swap with domain enforcement, and ALWAYS strips userinfo
    /// from the returned URL (browsers reject userinfo URLs, so we synthesize
    /// an `Authorization` header instead).
    ///
    /// Notes vs TS:
    /// - Foundation's `URLComponents` is the closest analog to the JS `URL`
    ///   class, but its `.user` / `.password` getters return the percent-
    ///   encoded values. The TS path uses `decodeURIComponent` on each half
    ///   before scanning — we mirror that with `removingPercentEncoding`.
    /// - Setting `URLComponents.user = nil` and `.password = nil` is the
    ///   Foundation equivalent of `parsed.username = ''` / `.password = ''`.
    /// - If `URL(string:)` succeeds but `URLComponents` fails (rare), we
    ///   return the URL unchanged, same as the TS catch-all.
    func extractAndUnmaskUrlCredentials(rawUrl: String) -> ExtractedUrlCreds {
        guard var components = URLComponents(string: rawUrl) else {
            return ExtractedUrlCreds(url: rawUrl, syntheticAuthorization: nil, forbidden: nil)
        }
        let userEncoded = components.user
        let passEncoded = components.password
        if (userEncoded ?? "").isEmpty && (passEncoded ?? "").isEmpty {
            return ExtractedUrlCreds(url: rawUrl, syntheticAuthorization: nil, forbidden: nil)
        }

        var user = (userEncoded?.removingPercentEncoding) ?? (userEncoded ?? "")
        var pass = (passEncoded?.removingPercentEncoding) ?? (passEncoded ?? "")
        let host = components.host ?? ""
        var touched = false
        for secret in secrets {
            let inUser = user.contains(secret.maskedValue)
            let inPass = pass.contains(secret.maskedValue)
            guard inUser || inPass else { continue }
            guard isAllowedDomain(patterns: secret.domains, hostname: host) else {
                return ExtractedUrlCreds(
                    url: rawUrl,
                    syntheticAuthorization: nil,
                    forbidden: ForbiddenInfo(secretName: secret.name, hostname: host)
                )
            }
            if inUser {
                user = user.replacingOccurrences(of: secret.maskedValue, with: secret.realValue)
                touched = true
            }
            if inPass {
                pass = pass.replacingOccurrences(of: secret.maskedValue, with: secret.realValue)
                touched = true
            }
        }
        let synthetic: String?
        if touched && !(user.isEmpty && pass.isEmpty) {
            let combined = "\(user):\(pass)"
            synthetic = "Basic \(Data(combined.utf8).base64EncodedString())"
        } else {
            synthetic = nil
        }
        components.user = nil
        components.password = nil
        let stripped = components.string ?? rawUrl
        return ExtractedUrlCreds(url: stripped, syntheticAuthorization: synthetic, forbidden: nil)
    }

    /// Mirrors TS `SecretsPipeline.unmaskBodyBytes`.
    ///
    /// Byte-level masked → real replacement for raw request bodies. Domain
    /// mismatch leaves the bytes untouched (no forbidden — matches TS).
    ///
    /// We never round-trip arbitrary bytes through `String(decoding:)` /
    /// `String.replacingOccurrences` because that would corrupt arbitrary
    /// non-UTF-8 bytes (Foundation uses U+FFFD on decode failure, which is a
    /// silent data-loss bug for e.g. SSE chunks that happen to land mid-CJK
    /// codepoint). Instead we scan with `Data.range(of:)` and rebuild.
    func unmaskBodyBytes(bytes: Data, targetHostname: String) -> Data {
        var out = bytes
        for secret in secrets {
            guard isAllowedDomain(patterns: secret.domains, hostname: targetHostname) else { continue }
            let needle = Data(secret.maskedValue.utf8)
            let replacement = Data(secret.realValue.utf8)
            out = replaceAllBytes(in: out, needle: needle, replacement: replacement)
        }
        return out
    }

    /// Mirrors TS `SecretsPipeline.scrubResponseBytes`.
    ///
    /// Byte-level real → masked replacement for streaming response bodies.
    /// Same anti-corruption discipline as `unmaskBodyBytes` — no String
    /// round-trip on arbitrary bytes.
    func scrubResponseBytes(bytes: Data) -> Data {
        var out = bytes
        for secret in secrets {
            let needle = Data(secret.realValue.utf8)
            let replacement = Data(secret.maskedValue.utf8)
            out = replaceAllBytes(in: out, needle: needle, replacement: replacement)
        }
        return out
    }
}

// MARK: - Internal helpers

/// Best-effort base64 decode that matches `atob`'s tolerance for missing
/// padding. Foundation's `Data(base64Encoded:)` rejects unpadded inputs;
/// `.ignoreUnknownCharacters` is needed for whitespace tolerance.
private func decodeBase64ToString(_ s: String) -> String? {
    let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
    let padded: String = {
        let rem = trimmed.count % 4
        if rem == 0 { return trimmed }
        return trimmed + String(repeating: "=", count: 4 - rem)
    }()
    if let data = Data(base64Encoded: padded, options: [.ignoreUnknownCharacters]),
       let text = String(data: data, encoding: .utf8) {
        return text
    }
    return nil
}

/// Byte-level scan-and-replace. Equivalent of TS `replaceAllBytes`.
/// Returns `haystack` unchanged when `needle` is empty or absent.
private func replaceAllBytes(in haystack: Data, needle: Data, replacement: Data) -> Data {
    guard !needle.isEmpty else { return haystack }
    if haystack.range(of: needle) == nil { return haystack }
    var out = Data()
    var cursor = haystack.startIndex
    while cursor < haystack.endIndex {
        let searchRange = cursor..<haystack.endIndex
        guard let match = haystack.range(of: needle, options: [], in: searchRange) else {
            out.append(haystack[cursor..<haystack.endIndex])
            break
        }
        if match.lowerBound > cursor {
            out.append(haystack[cursor..<match.lowerBound])
        }
        out.append(replacement)
        cursor = match.upperBound
    }
    return out
}

