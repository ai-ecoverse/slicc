import Foundation

/// In-memory writable store for OAuth token replicas pushed by the webapp.
///
/// Mirrors `packages/node-server/src/secrets/oauth-secret-store.ts`. The
/// webapp pushes OAuth provider access tokens to the server so the
/// fetch-proxy can unmask them on outbound git/fetch requests. The store is
/// process-local — there is no on-disk persistence — because the webapp
/// re-pushes every entry on bootstrap from its own IndexedDB-backed copy.
///
/// Implemented as an actor so concurrent `set` / `delete` / `list` calls
/// from the HTTP handler tasks are serialized without an explicit lock.
public actor OAuthSecretStore {
    public struct Entry: Sendable, Equatable {
        public let name: String
        public let value: String
        public let domains: [String]

        public init(name: String, value: String, domains: [String]) {
            self.name = name
            self.value = value
            self.domains = domains
        }
    }

    public enum OAuthSecretStoreError: Error, Sendable, Equatable, LocalizedError {
        case emptyDomains

        public var errorDescription: String? {
            switch self {
            case .emptyDomains:
                return "OAuthSecretStore: domains must be non-empty"
            }
        }
    }

    private var entries: [String: Entry] = [:]

    public init() {}

    /// Insert or replace the entry for `name`. Rejects empty domain lists
    /// to match the TS `OauthSecretStore.set` contract.
    public func set(name: String, value: String, domains: [String]) throws {
        guard !domains.isEmpty else {
            throw OAuthSecretStoreError.emptyDomains
        }
        entries[name] = Entry(name: name, value: value, domains: domains)
    }

    /// Remove the entry for `name` (no-op if absent).
    public func delete(name: String) {
        entries.removeValue(forKey: name)
    }

    /// Return a snapshot of all entries.
    public func list() -> [Entry] {
        Array(entries.values)
    }

    /// Look up the raw secret value for `name`.
    public func get(name: String) -> String? {
        entries[name]?.value
    }
}
