import Foundation
import XCTest

@testable import SliccTrayVFS

final class TrayCredentialStoreTests: XCTestCase {
    private final class FailingAttributesFileManager: FileManager {
        override func setAttributes(
            _ attributes: [FileAttributeKey: Any], ofItemAtPath path: String
        ) throws {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(EPERM), userInfo: nil)
        }
    }

    private final class MemoryKeychain: TrayCredentialKeychain {
        var data: Data?
        var writeSucceeds = true

        func read() -> Data? { data }

        func write(_ data: Data) -> Bool {
            guard writeSucceeds else { return false }
            self.data = data
            return true
        }

        func clear() {
            data = nil
        }
    }

    private var suiteName: String!
    private var defaults: UserDefaults!
    private var credentialMetadata: [String: Any] {
        defaults.dictionaryRepresentation().filter { key, _ in
            key.hasPrefix("trayCredential.")
        }
    }

    override func setUp() {
        super.setUp()
        suiteName = "TrayCredentialStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testWriteReadClearRoundTripKeepsSecretOutOfDefaults() throws {
        let keychain = MemoryKeychain()
        let store = TrayCredentialStore(defaults: defaults, keychain: keychain)
        let joinURL = try XCTUnwrap(URL(string: "https://tray.example/join/session-secret"))
        let connectedAt = Date(timeIntervalSince1970: 1_750_000_000)

        XCTAssertTrue(
            store.save(
                joinURL: joinURL,
                trayID: "tray-123",
                displayName: "Chrome on MacBook",
                lastConnectedAt: connectedAt))
        XCTAssertEqual(
            store.load(),
            TrayCredentials(
                joinURL: joinURL,
                trayID: "tray-123",
                displayName: "Chrome on MacBook",
                lastConnectedAt: connectedAt))
        XCTAssertFalse(
            defaults.dictionaryRepresentation().values.contains { value in
                String(describing: value).contains("session-secret")
            })

        store.clear()

        XCTAssertNil(store.load())
        XCTAssertNil(keychain.data)
        XCTAssertTrue(credentialMetadata.isEmpty)
    }

    func testUnavailableAppGroupAndKeychainDegradeWithoutMutation() throws {
        let store = TrayCredentialStore(defaults: nil, keychain: nil)
        let joinURL = try XCTUnwrap(URL(string: "https://tray.example/join/unavailable-secret"))

        XCTAssertFalse(
            store.save(
                joinURL: joinURL,
                trayID: "tray-123",
                displayName: nil))
        XCTAssertNil(store.load())
        store.clear()
    }

    func testKeychainWriteFailureDoesNotPublishMetadata() throws {
        let keychain = MemoryKeychain()
        keychain.writeSucceeds = false
        let store = TrayCredentialStore(defaults: defaults, keychain: keychain)
        let joinURL = try XCTUnwrap(URL(string: "https://tray.example/join/rejected-secret"))

        XCTAssertFalse(
            store.save(
                joinURL: joinURL,
                trayID: "tray-123",
                displayName: "Unavailable"))
        XCTAssertNil(store.load())
        XCTAssertTrue(credentialMetadata.isEmpty)
    }

    func testAppGroupFileStoreRoundTripAndClear() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TrayCredentialFileStore.\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AppGroupFileSecretStore(directory: directory)
        let payload = Data("https://tray.example/join/file-secret".utf8)
        let fileURL = directory.appendingPathComponent("join-url", isDirectory: false)

        XCTAssertTrue(store.write(payload))
        XCTAssertEqual(store.read(), payload)
        XCTAssertEqual(try Data(contentsOf: fileURL), payload)
        let mode = try FileManager.default.attributesOfItem(atPath: fileURL.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.uint16Value, 0o600)

        store.clear()

        XCTAssertNil(store.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
    }

    func testAppGroupFileStoreWriteCleansTempAndPreservesExistingOnAttributeFailure() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TrayCredentialFileStore.\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("join-url", isDirectory: false)
        let original = Data("https://tray.example/join/original".utf8)
        XCTAssertTrue(AppGroupFileSecretStore(directory: directory).write(original))

        let store = AppGroupFileSecretStore(
            directory: directory, fileManager: FailingAttributesFileManager())
        XCTAssertFalse(store.write(Data("https://tray.example/join/rejected".utf8)))
        XCTAssertEqual(try Data(contentsOf: fileURL), original)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent(".join-url.tmp", isDirectory: false).path))
    }

    func testAppGroupFileStoreReadMissesMissingFile() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TrayCredentialFileStore.\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AppGroupFileSecretStore(directory: directory)

        XCTAssertNil(store.read())
        XCTAssertTrue(store.write(Data("secret".utf8)))
        store.clear()
        XCTAssertNil(store.read())
    }

    func testFileBackedStoreKeepsSecretOutOfDefaults() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TrayCredentialFileStore.\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileStore = AppGroupFileSecretStore(directory: directory)
        let store = TrayCredentialStore(defaults: defaults, keychain: fileStore)
        let joinURL = try XCTUnwrap(URL(string: "https://tray.example/join/file-backed-secret"))

        XCTAssertTrue(
            store.save(joinURL: joinURL, trayID: "tray-file", displayName: nil))
        XCTAssertEqual(store.load()?.joinURL, joinURL)
        XCTAssertFalse(
            defaults.dictionaryRepresentation().values.contains { value in
                String(describing: value).contains("file-backed-secret")
            })

        store.clear()
        XCTAssertNil(store.load())
    }

    func testKeychainUpdateFailurePreservesPreviousCredential() throws {
        let keychain = MemoryKeychain()
        let store = TrayCredentialStore(defaults: defaults, keychain: keychain)
        let originalURL = try XCTUnwrap(URL(string: "https://tray.example/join/original-secret"))
        let originalDate = Date(timeIntervalSince1970: 1_750_000_000)
        XCTAssertTrue(
            store.save(
                joinURL: originalURL,
                trayID: "original-tray",
                displayName: "Original leader",
                lastConnectedAt: originalDate))
        let originalCredential = try XCTUnwrap(store.load())
        keychain.writeSucceeds = false

        XCTAssertFalse(
            store.save(
                joinURL: try XCTUnwrap(URL(string: "https://tray.example/join/rejected-secret")),
                trayID: "replacement-tray",
                displayName: "Replacement leader"))

        XCTAssertEqual(store.load(), originalCredential)
    }
}
