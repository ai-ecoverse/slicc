import Foundation















public final class SecretInjector: @unchecked Sendable {

    
    
    
    
    
    
    
    
    
    
    struct LoadedSecret: Sendable {
        let name: String
        let realValue: String
        let maskedValue: String
        let domains: [String]
        let isMaskable: Bool

        init(name: String, realValue: String, maskedValue: String, domains: [String], isMaskable: Bool = true) {
            self.name = name
            self.realValue = realValue
            self.maskedValue = maskedValue
            self.domains = domains
            self.isMaskable = isMaskable
        }
    }

    
    enum InjectionResult: Sendable {
        
        case success(text: String)
        
        case domainBlocked(secretName: String, hostname: String)
    }

    
    struct ForbiddenInfo: Sendable, Equatable {
        let secretName: String
        let hostname: String
    }

    
    
    struct BasicResult: Sendable, Equatable {
        let value: String
        let forbidden: ForbiddenInfo?
    }

    
    struct ExtractedUrlCreds: Sendable, Equatable {
        let url: String
        let syntheticAuthorization: String?
        let forbidden: ForbiddenInfo?
    }

    
    
    
    
    
    struct HmacSignResult: Sendable, Equatable {
        let headerName: String?
        let signatureHex: String?
        let timestampHeaderName: String?
        let timestampValue: String?
        let forbidden: ForbiddenInfo?
    }

    
    private let sessionId: String?

    
    private let _envFileSecrets: [Secret]

    
    let persistedStore: SecretStoreAccess
    let sessionStore: SessionSecretStore

    
    
    
    
    
    
    
    
    
    
    func envFileShadows(_ name: String) -> Bool {
        _envFileSecrets.contains { $0.name == name }
    }

    private let lock = NSLock()
    private nonisolated(unsafe) var _secrets: [LoadedSecret]
    private nonisolated(unsafe) var _responseScrubber: @Sendable (String) -> String
    private nonisolated(unsafe) var _oauthStore: OAuthSecretStore?

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

    private var oauthStore: OAuthSecretStore? {
        lock.lock()
        defer { lock.unlock() }
        return _oauthStore
    }

    private func setSecretsAndScrubber(secrets: [LoadedSecret], scrubber: @Sendable @escaping (String) -> String) {
        lock.lock()
        defer { lock.unlock() }
        _secrets = secrets
        _responseScrubber = scrubber
    }

    
    init(
        secrets: [LoadedSecret],
        persistedStore: SecretStoreAccess = .keychain,
        sessionStore: SessionSecretStore = SessionSecretStore()
    ) {
        self.sessionId = nil
        self._envFileSecrets = []
        self.persistedStore = persistedStore
        self.sessionStore = sessionStore
        self._secrets = secrets
        let pairs = secrets.map { SecretPair(realValue: $0.realValue, maskedValue: $0.maskedValue) }
        self._responseScrubber = buildScrubber(secrets: pairs)
        self._oauthStore = nil
    }

    
    
    
    
    
    
    
    
    
    
    init(
        sessionId: String,
        envFileSecrets: [Secret] = [],
        persistedStore: SecretStoreAccess = .keychain,
        sessionStore: SessionSecretStore = SessionSecretStore(),
        oauthStore: OAuthSecretStore? = nil
    ) {
        self.sessionId = sessionId
        self._envFileSecrets = envFileSecrets
        self.persistedStore = persistedStore
        self.sessionStore = sessionStore
        self._secrets = []
        self._responseScrubber = { $0 }
        self._oauthStore = oauthStore
        
        
        
        
        loadSecretsKeychainAndEnv()
    }

    
    
    
    func setOAuthStore(_ store: OAuthSecretStore) {
        lock.lock()
        defer { lock.unlock() }
        _oauthStore = store
    }

    
    
    
    
    func reload() async {
        guard let sessionId else { return }
        
        
        
        
        
        let store = persistedStore
        guard let persisted = await BoundedStoreCall.run({ store.loadAll() }) else {
            try? FileHandle.standardError.write(
                contentsOf:
                    Data("[slicc:secrets] \(BoundedStoreCall.timeoutMessage) Keeping the previous snapshot.\n".utf8)
            )
            return
        }
        var loaded = self.loadSecretsKeychainAndEnvSnapshot(persisted: persisted)

        
        
        
        if let store = oauthStore {
            for entry in await store.list() {
                
                
                
                
                
                if entry.value.utf16.count < minMaskableSecretLength {
                    try? FileHandle.standardError.write(
                        contentsOf:
                            Data(
                                "[slicc:secrets] secret \"\(entry.name)\" not masked: value shorter than \(minMaskableSecretLength) chars\n".utf8
                            ))
                    let shortEntry = LoadedSecret(
                        name: entry.name,
                        realValue: entry.value,
                        maskedValue: entry.value,
                        domains: entry.domains,
                        isMaskable: false
                    )
                    if let idx = loaded.firstIndex(where: { $0.name == entry.name }) {
                        loaded[idx] = shortEntry
                    } else {
                        loaded.append(shortEntry)
                    }
                    continue
                }
                let masked = mask(sessionId: sessionId, secretName: entry.name, realValue: entry.value)
                let loadedEntry = LoadedSecret(
                    name: entry.name,
                    realValue: entry.value,
                    maskedValue: masked,
                    domains: entry.domains
                )
                if let idx = loaded.firstIndex(where: { $0.name == entry.name }) {
                    loaded[idx] = loadedEntry
                } else {
                    loaded.append(loadedEntry)
                }
            }
        }

        
        
        let persistedNames = Set(loaded.map(\.name))
        for entry in await sessionStore.listAll() where !persistedNames.contains(entry.name) {
            if entry.value.utf16.count < minMaskableSecretLength {
                try? FileHandle.standardError.write(
                    contentsOf:
                        Data(
                            "[slicc:secrets] secret \"\(entry.name)\" not masked: value shorter than \(minMaskableSecretLength) chars\n".utf8
                        ))
                loaded.append(
                    LoadedSecret(
                        name: entry.name,
                        realValue: entry.value,
                        maskedValue: entry.value,
                        domains: entry.domains,
                        isMaskable: false
                    ))
                continue
            }
            loaded.append(
                LoadedSecret(
                    name: entry.name,
                    realValue: entry.value,
                    maskedValue: mask(sessionId: sessionId, secretName: entry.name, realValue: entry.value),
                    domains: entry.domains
                ))
        }

        
        
        
        let pairs =
            loaded
            .filter { $0.isMaskable }
            .map { SecretPair(realValue: $0.realValue, maskedValue: $0.maskedValue) }
        setSecretsAndScrubber(secrets: loaded, scrubber: buildScrubber(secrets: pairs))
    }

    
    
    
    private func loadSecretsKeychainAndEnv() {
        let loaded = loadSecretsKeychainAndEnvSnapshot()
        
        
        let pairs =
            loaded
            .filter { $0.isMaskable }
            .map { SecretPair(realValue: $0.realValue, maskedValue: $0.maskedValue) }
        setSecretsAndScrubber(secrets: loaded, scrubber: buildScrubber(secrets: pairs))
    }

    
    
    
    private func loadSecretsKeychainAndEnvSnapshot(persisted: [Secret]? = nil) -> [LoadedSecret] {
        guard let sessionId else { return [] }
        
        
        
        var loaded: [LoadedSecret] = []
        for secret in persisted ?? persistedStore.loadAll() {
            
            
            
            
            
            
            
            
            if secret.value.utf16.count < minMaskableSecretLength {
                try? FileHandle.standardError.write(
                    contentsOf:
                        Data(
                            "[slicc:secrets] secret \"\(secret.name)\" not masked: value shorter than \(minMaskableSecretLength) chars\n".utf8
                        ))
                loaded.append(
                    LoadedSecret(
                        name: secret.name,
                        realValue: secret.value,
                        maskedValue: secret.value,
                        domains: secret.domains,
                        isMaskable: false
                    ))
                continue
            }
            let masked = mask(sessionId: sessionId, secretName: secret.name, realValue: secret.value)
            loaded.append(
                LoadedSecret(
                    name: secret.name,
                    realValue: secret.value,
                    maskedValue: masked,
                    domains: secret.domains
                ))
        }

        
        for secret in _envFileSecrets {
            if secret.value.utf16.count < minMaskableSecretLength {
                try? FileHandle.standardError.write(
                    contentsOf:
                        Data(
                            "[slicc:secrets] secret \"\(secret.name)\" not masked: value shorter than \(minMaskableSecretLength) chars\n".utf8
                        ))
                
                
                
                
                let shortEntry = LoadedSecret(
                    name: secret.name,
                    realValue: secret.value,
                    maskedValue: secret.value,
                    domains: secret.domains,
                    isMaskable: false
                )
                if let idx = loaded.firstIndex(where: { $0.name == secret.name }) {
                    loaded[idx] = shortEntry
                } else {
                    loaded.append(shortEntry)
                }
                continue
            }
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
        return loaded
    }

    
    
    
    func maskedValue(for name: String) -> String? {
        secrets.first(where: { $0.name == name })?.maskedValue
    }

    

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    static func readOrCreateSessionId(in dir: URL) throws -> String {
        let fm = FileManager.default
        let path = dir.appendingPathComponent("session-id")
        if fm.fileExists(atPath: path.path),
            let data = try? Data(contentsOf: path),
            let raw = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty,
            UUID(uuidString: raw) != nil
        {
            return raw
        }
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let fresh = UUID().uuidString
        
        
        try (fresh + "\n").data(using: .utf8)!.write(to: path, options: .atomic)
        
        try? fm.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o600))],
            ofItemAtPath: path.path
        )
        return fresh
    }

    
    
    
    
    var isEmpty: Bool { secrets.allSatisfy { !$0.isMaskable } }

    
    
    
    
    var maskedEnvironment: [String: String] {
        var env: [String: String] = [:]
        for s in secrets {
            env[s.name] = s.maskedValue
        }
        return env
    }

    
    
    
    
    var maskedEntries: [(name: String, maskedValue: String, domains: [String])] {
        secrets.map { (name: $0.name, maskedValue: $0.maskedValue, domains: $0.domains) }
    }

    
    
    
    
    
    
    func inject(text: String, hostname: String) -> InjectionResult {
        var result = text
        for secret in secrets {
            
            
            
            
            guard secret.isMaskable else { continue }
            guard result.contains(secret.maskedValue) else { continue }
            guard isAllowedDomain(patterns: secret.domains, hostname: hostname) else {
                return .domainBlocked(secretName: secret.name, hostname: hostname)
            }
            result = result.replacingOccurrences(of: secret.maskedValue, with: secret.realValue)
        }
        return .success(text: result)
    }

    
    
    
    
    
    
    func injectBody(text: String, hostname: String) -> String {
        var result = text
        for secret in secrets {
            guard secret.isMaskable else { continue }
            guard result.contains(secret.maskedValue) else { continue }
            guard isAllowedDomain(patterns: secret.domains, hostname: hostname) else {
                
                continue
            }
            result = result.replacingOccurrences(of: secret.maskedValue, with: secret.realValue)
        }
        return result
    }

    
    func scrub(text: String) -> String {
        responseScrubber(text)
    }

    

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    func unmaskAuthorizationBasic(value: String, targetHostname: String) -> BasicResult {
        
        let trimmedHeader = value
        guard
            let match = trimmedHeader.range(
                of: #"^Basic\s+(.+)$"#,
                options: .regularExpression
            ), match.lowerBound == trimmedHeader.startIndex
        else {
            return BasicResult(value: value, forbidden: nil)
        }
        let payload = String(trimmedHeader[match])
            .dropFirst("Basic".count)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard let decoded = decodeBase64ToString(String(payload)) else {
            return BasicResult(value: value, forbidden: nil)
        }
        
        guard let colonIdx = decoded.firstIndex(of: ":") else {
            return BasicResult(value: value, forbidden: nil)
        }
        var user = String(decoded[..<colonIdx])
        var pass = String(decoded[decoded.index(after: colonIdx)...])
        var touched = false
        for secret in secrets {
            guard secret.isMaskable else { continue }
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
            guard secret.isMaskable else { continue }
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

    
    
    
    
    
    
    
    
    
    
    func unmaskBodyBytes(bytes: Data, targetHostname: String) -> Data {
        var out = bytes
        for secret in secrets {
            guard secret.isMaskable else { continue }
            guard isAllowedDomain(patterns: secret.domains, hostname: targetHostname) else { continue }
            let needle = Data(secret.maskedValue.utf8)
            let replacement = Data(secret.realValue.utf8)
            out = replaceAllBytes(in: out, needle: needle, replacement: replacement)
        }
        return out
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    func signHmac(
        spec: String,
        body: [UInt8],
        targetHostname: String,
        now: () -> Date = { Date() }
    ) -> HmacSignResult {
        func empty() -> HmacSignResult {
            HmacSignResult(headerName: nil, signatureHex: nil, timestampHeaderName: nil, timestampValue: nil, forbidden: nil)
        }

        guard let sep = spec.firstIndex(of: ":") else { return empty() }
        let secretName = String(spec[spec.startIndex..<sep]).trimmingCharacters(in: .whitespaces)
        let rest = String(spec[spec.index(after: sep)...])
        let headerName: String
        let timestampHeader: String?
        if let sep2 = rest.firstIndex(of: ":") {
            headerName = String(rest[rest.startIndex..<sep2]).trimmingCharacters(in: .whitespaces)
            timestampHeader = String(rest[rest.index(after: sep2)...]).trimmingCharacters(in: .whitespaces)
        } else {
            headerName = rest.trimmingCharacters(in: .whitespaces)
            timestampHeader = nil
        }
        guard !secretName.isEmpty, !headerName.isEmpty else { return empty() }
        if let timestampHeader, timestampHeader.isEmpty { return empty() }

        guard let secret = secrets.first(where: { $0.name == secretName }) else {
            try? FileHandle.standardError.write(
                contentsOf:
                    Data(
                        "[slicc:secrets] signHmac: no secret named \"\(secretName)\"\n".utf8
                    ))
            return empty()
        }
        guard isAllowedDomain(patterns: secret.domains, hostname: targetHostname) else {
            return HmacSignResult(
                headerName: nil,
                signatureHex: nil,
                timestampHeaderName: nil,
                timestampValue: nil,
                forbidden: ForbiddenInfo(secretName: secret.name, hostname: targetHostname)
            )
        }

        if let timestampHeader, !timestampHeader.isEmpty {
            let timestampValue = String(Int(now().timeIntervalSince1970))
            let message = Array("\(timestampValue).".utf8) + body
            let signatureHex = hmacSHA256Hex(key: secret.realValue, message: message)
            return HmacSignResult(
                headerName: headerName,
                signatureHex: signatureHex,
                timestampHeaderName: timestampHeader,
                timestampValue: timestampValue,
                forbidden: nil
            )
        }

        let signatureHex = hmacSHA256Hex(key: secret.realValue, message: body)
        return HmacSignResult(headerName: headerName, signatureHex: signatureHex, timestampHeaderName: nil, timestampValue: nil, forbidden: nil)
    }

    
    
    
    
    
    
    
    
    
    
    
    
    func redactForExport(texts: [String]) -> (texts: [String], redactionCount: Int) {
        let maskableSecrets = secrets.filter { $0.isMaskable }
        let shortSecrets = secrets.filter { !$0.isMaskable }
        struct MarkerSpec {
            let values: [String]
            let marker: String
        }
        
        var allMarkers: [MarkerSpec] = maskableSecrets.enumerated().map { index, secret in
            MarkerSpec(
                values: [secret.realValue, secret.maskedValue].filter { !$0.isEmpty },
                marker: "⟦REDACTED:known-secret:k\(index + 1)⟧"
            )
        }
        
        let base = maskableSecrets.count
        for (index, secret) in shortSecrets.enumerated() {
            allMarkers.append(
                MarkerSpec(
                    values: [secret.realValue],
                    marker: "⟦REDACTED:known-secret:k\(base + index + 1)⟧"
                ))
        }
        var redactionCount = 0
        let redacted: [String] = texts.map { input in
            var output = input
            for spec in allMarkers {
                for value in spec.values {
                    let occurrences = output.components(separatedBy: value).count - 1
                    redactionCount += occurrences
                    output = output.replacingOccurrences(of: value, with: spec.marker)
                }
            }
            return output
        }
        return (texts: redacted, redactionCount: redactionCount)
    }

    
    
    
    
    
    func scrubResponseBytes(bytes: Data) -> Data {
        var out = bytes
        for secret in secrets {
            
            
            
            
            
            guard secret.isMaskable else { continue }
            let needle = Data(secret.realValue.utf8)
            let replacement = Data(secret.maskedValue.utf8)
            out = replaceAllBytes(in: out, needle: needle, replacement: replacement)
        }
        return out
    }
}






private func decodeBase64ToString(_ s: String) -> String? {
    let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
    let padded: String = {
        let rem = trimmed.count % 4
        if rem == 0 { return trimmed }
        return trimmed + String(repeating: "=", count: 4 - rem)
    }()
    if let data = Data(base64Encoded: padded, options: [.ignoreUnknownCharacters]),
        let text = String(data: data, encoding: .utf8)
    {
        return text
    }
    return nil
}



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
