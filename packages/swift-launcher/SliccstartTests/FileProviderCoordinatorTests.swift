import FileProvider
import Foundation
import XCTest

@testable import SliccTrayVFS
@testable import Sliccstart

@MainActor
final class FileProviderCoordinatorTests: XCTestCase {
    private final class RecordingRegistrar: FileProviderDomainRegistering {
        var added = 0
        var removed = 0

        func add(_ domain: NSFileProviderDomain, completionHandler: @escaping (Error?) -> Void) {
            added += 1
            completionHandler(nil)
        }

        func remove(_ domain: NSFileProviderDomain, completionHandler: @escaping (Error?) -> Void) {
            removed += 1
            completionHandler(nil)
        }

        func getDomains(completionHandler: @escaping ([NSFileProviderDomain], Error?) -> Void) {
            completionHandler([], nil)
        }
    }

    private final class MemoryKeychain: TrayCredentialKeychain {
        var data: Data?
        func read() -> Data? { data }
        func write(_ data: Data) -> Bool { self.data = data; return true }
        func clear() { data = nil }
    }

    func testLeaderJoinUrlPersistsCredentialsAndRegistersDomain() {
        let suite = "FileProviderCoordinatorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(true, forKey: FileProviderCoordinator.enabledKey)
        let keychain = MemoryKeychain()
        let registrar = RecordingRegistrar()
        let store = TrayCredentialStore(defaults: defaults, keychain: keychain)
        let coordinator = FileProviderCoordinator(
            credentialStore: store,
            domainLifecycle: FileProviderDomainLifecycle(
                registrar: registrar, defaults: defaults),
            defaults: defaults)

        coordinator.leaderJoinUrlChanged(
            "https://tray.example/join/session-secret", label: "Chrome")

        XCTAssertNotNil(store.load())
        XCTAssertEqual(registrar.added, 1)
    }

    func testDisabledSkipsDomainRegistration() {
        let suite = "FileProviderCoordinatorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(false, forKey: FileProviderCoordinator.enabledKey)
        let registrar = RecordingRegistrar()
        let coordinator = FileProviderCoordinator(
            credentialStore: TrayCredentialStore(
                defaults: defaults, keychain: MemoryKeychain()),
            domainLifecycle: FileProviderDomainLifecycle(
                registrar: registrar, defaults: defaults),
            defaults: defaults)

        coordinator.leaderJoinUrlChanged(
            "https://tray.example/join/session-secret", label: "Chrome")

        XCTAssertEqual(registrar.added, 0)
        XCTAssertGreaterThanOrEqual(registrar.removed, 1)
    }

    func testClearingLeaderJoinUrlRemovesCredentialsAndDomain() {
        let suite = "FileProviderCoordinatorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(true, forKey: FileProviderCoordinator.enabledKey)
        let keychain = MemoryKeychain()
        let registrar = RecordingRegistrar()
        let store = TrayCredentialStore(defaults: defaults, keychain: keychain)
        let coordinator = FileProviderCoordinator(
            credentialStore: store,
            domainLifecycle: FileProviderDomainLifecycle(
                registrar: registrar, defaults: defaults),
            defaults: defaults)

        coordinator.leaderJoinUrlChanged(
            "https://tray.example/join/session-secret", label: "Chrome")
        coordinator.leaderJoinUrlChanged(nil, label: nil)

        XCTAssertNil(store.load())
        XCTAssertGreaterThanOrEqual(registrar.removed, 1)
    }
}
