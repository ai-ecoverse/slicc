import Foundation
import Security

public struct TrayCredentials: Equatable, Sendable {
    public let joinURL: URL
    public let trayID: String
    public let displayName: String?
    public let lastConnectedAt: Date

    public init(
        joinURL: URL,
        trayID: String,
        displayName: String?,
        lastConnectedAt: Date
    ) {
        self.joinURL = joinURL
        self.trayID = trayID
        self.displayName = displayName
        self.lastConnectedAt = lastConnectedAt
    }
}

public protocol TrayCredentialKeychain: AnyObject {
    func read() -> Data?
    func write(_ data: Data) -> Bool
    func clear()
}

public final class TrayCredentialStore {
    public static var appGroupIdentifier: String { TrayCredentialConfiguration.appGroupIdentifier }
    public static var keychainAccessGroup: String { TrayCredentialConfiguration.keychainAccessGroup }

    private enum MetadataKey {
        static let trayID = "trayCredential.trayID"
        static let displayName = "trayCredential.displayName"
        static let lastConnectedAt = "trayCredential.lastConnectedAt"
        static let all = [trayID, displayName, lastConnectedAt]
    }

    private let defaults: UserDefaults?
    private let keychain: TrayCredentialKeychain?

    public convenience init() {
        let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier)
        self.init(
            defaults: container != nil
                ? UserDefaults(suiteName: Self.appGroupIdentifier)
                : nil,
            keychain: Self.makeSecretStore(container: container)
        )
    }

    
    
    
    
    
    private static func makeSecretStore(container: URL?) -> TrayCredentialKeychain? {
        guard let container else { return nil }
        #if os(macOS)
            return AppGroupFileSecretStore(
                directory: container.appendingPathComponent(
                    "Library/Application Support/slicc-tray-credentials", isDirectory: true))
        #else
            return SystemTrayCredentialKeychain(accessGroup: Self.keychainAccessGroup)
        #endif
    }

    init(defaults: UserDefaults?, keychain: TrayCredentialKeychain?) {
        self.defaults = defaults
        self.keychain = keychain
    }

    @discardableResult
    public func save(
        joinURL: URL,
        trayID: String,
        displayName: String?,
        lastConnectedAt: Date = Date()
    ) -> Bool {
        guard !trayID.isEmpty, let defaults, let keychain else { return false }
        guard keychain.write(Data(joinURL.absoluteString.utf8)) else {
            
            
            return false
        }

        defaults.set(trayID, forKey: MetadataKey.trayID)
        if let displayName, !displayName.isEmpty {
            defaults.set(displayName, forKey: MetadataKey.displayName)
        } else {
            defaults.removeObject(forKey: MetadataKey.displayName)
        }
        defaults.set(lastConnectedAt, forKey: MetadataKey.lastConnectedAt)
        return true
    }

    public func load() -> TrayCredentials? {
        guard let defaults, let keychain,
            let secret = keychain.read(),
            let rawURL = String(data: secret, encoding: .utf8),
            let joinURL = URL(string: rawURL),
            let trayID = defaults.string(forKey: MetadataKey.trayID),
            let lastConnectedAt = defaults.object(forKey: MetadataKey.lastConnectedAt) as? Date
        else { return nil }

        return TrayCredentials(
            joinURL: joinURL,
            trayID: trayID,
            displayName: defaults.string(forKey: MetadataKey.displayName),
            lastConnectedAt: lastConnectedAt
        )
    }

    public func clear() {
        if let defaults { removeMetadata(from: defaults) }
        keychain?.clear()
    }

    private func removeMetadata(from defaults: UserDefaults) {
        for key in MetadataKey.all {
            defaults.removeObject(forKey: key)
        }
    }
}



final class AppGroupFileSecretStore: TrayCredentialKeychain {
    private let fileURL: URL
    private let fileManager: FileManager

    init(directory: URL, fileManager: FileManager = .default) {
        fileURL = directory.appendingPathComponent("join-url", isDirectory: false)
        self.fileManager = fileManager
    }

    func read() -> Data? {
        try? Data(contentsOf: fileURL)
    }

    func write(_ data: Data) -> Bool {
        let directory = fileURL.deletingLastPathComponent()
        let tempURL = directory.appendingPathComponent(".join-url.tmp", isDirectory: false)
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: tempURL, options: .atomic)
            try fileManager.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: tempURL.path)
            if fileManager.fileExists(atPath: fileURL.path) {
                _ = try fileManager.replaceItemAt(fileURL, withItemAt: tempURL)
            } else {
                try fileManager.moveItem(at: tempURL, to: fileURL)
            }
            return true
        } catch {
            try? fileManager.removeItem(at: tempURL)
            return false
        }
    }

    func clear() {
        try? fileManager.removeItem(at: fileURL)
    }
}

private final class SystemTrayCredentialKeychain: TrayCredentialKeychain {
    private static let service = "ai.sliccy.follower.tray"
    private static let account = "join-url"
    private let accessGroup: String

    init(accessGroup: String) {
        self.accessGroup = accessGroup
    }

    func read() -> Data? {
        var query = identityQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    func write(_ data: Data) -> Bool {
        let updateStatus = SecItemUpdate(
            identityQuery as CFDictionary,
            [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        guard updateStatus == errSecItemNotFound else { return false }

        var query = identityQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    func clear() {
        SecItemDelete(identityQuery as CFDictionary)
    }

    private var identityQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
    }
}
