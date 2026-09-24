import Foundation
import Security

@testable import slicc_server

/// In-memory stand-in for the login Keychain behind `SecretStore`'s
/// Security.framework seams (`keychainRead` / `keychainUpdate` / `keychainAdd`).
///
/// Any test that reaches `SecretStore` — directly, through
/// `SecretStoreAccess.keychain`, `SecretInjector`'s default `persistedStore`,
/// or `SignAndForward.defaultSecretLookup` — must `install()` this in `setUp`.
/// The real item is the developer's `ai.sliccy.slicc / __envfile__` blob: its
/// ACL trusts Sliccstart and slicc-server, not `xctest`, so every real touch
/// raises the Keychain access dialog, and writes would land in real secrets.
final class InMemoryKeychain: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private var _lastReadQuery: [String: Any]?

    /// The query `SecretStore.readBlob()` last sent, for asserting on flags
    /// like `kSecUseAuthenticationUI`.
    var lastReadQuery: [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        return _lastReadQuery
    }

    @discardableResult
    static func install() -> InMemoryKeychain {
        let keychain = InMemoryKeychain()
        SecretStore.keychainRead = { query in keychain.read(query) }
        SecretStore.keychainUpdate = { query, attributes in keychain.update(query, attributes) }
        SecretStore.keychainAdd = { query in keychain.add(query) }
        return keychain
    }

    static func uninstall() {
        SecretStore.resetKeychainOperations()
    }

    private static func key(_ query: [String: Any]) -> String {
        let service = query[kSecAttrService as String] as? String ?? ""
        let account = query[kSecAttrAccount as String] as? String ?? ""
        return "\(service)/\(account)"
    }

    private func read(_ query: [String: Any]) -> (OSStatus, AnyObject?) {
        lock.lock()
        defer { lock.unlock() }
        _lastReadQuery = query
        guard let data = items[Self.key(query)] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, data as NSData)
    }

    private func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        let key = Self.key(query)
        guard items[key] != nil else { return errSecItemNotFound }
        guard let data = attributes[kSecValueData as String] as? Data else { return errSecParam }
        items[key] = data
        return errSecSuccess
    }

    private func add(_ query: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        let key = Self.key(query)
        guard items[key] == nil else { return errSecDuplicateItem }
        guard let data = query[kSecValueData as String] as? Data else { return errSecParam }
        items[key] = data
        return errSecSuccess
    }
}
