import Foundation











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

    
    
    public func set(name: String, value: String, domains: [String]) throws {
        guard !domains.isEmpty else {
            throw OAuthSecretStoreError.emptyDomains
        }
        entries[name] = Entry(name: name, value: value, domains: domains)
    }

    
    public func delete(name: String) {
        entries.removeValue(forKey: name)
    }

    
    public func list() -> [Entry] {
        Array(entries.values)
    }

    
    public func get(name: String) -> String? {
        entries[name]?.value
    }
}
