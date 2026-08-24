import FileProvider
import XCTest

@testable import SliccTrayVFS

@MainActor
final class FileProviderDomainLifecycleTests: XCTestCase {
    private final class RecordingRegistrar: FileProviderDomainRegistering {
        var addedDomains: [NSFileProviderDomain] = []
        var removedDomains: [NSFileProviderDomain] = []
        var knownDomains: [NSFileProviderDomain] = []
        var error: Error?

        func add(
            _ domain: NSFileProviderDomain,
            completionHandler: @escaping (Error?) -> Void
        ) {
            addedDomains.append(domain)
            completionHandler(error)
        }

        func remove(
            _ domain: NSFileProviderDomain,
            completionHandler: @escaping (Error?) -> Void
        ) {
            removedDomains.append(domain)
            completionHandler(error)
        }

        func getDomains(completionHandler: @escaping ([NSFileProviderDomain], Error?) -> Void) {
            completionHandler(knownDomains, error)
        }
    }

    func testRegistrationRequiresCredentials() {
        let registrar = RecordingRegistrar()
        let defaults = UserDefaults(suiteName: "fileprovider.lifecycle.tests.\(UUID().uuidString)")
        let lifecycle = FileProviderDomainLifecycle(registrar: registrar, defaults: defaults)

        lifecycle.registerIfCredentialsAvailable(false)
        XCTAssertTrue(registrar.addedDomains.isEmpty)
        XCTAssertEqual(defaults?.string(forKey: "fileProvider.domainStatus"), "skipped-no-credentials")

        lifecycle.registerIfCredentialsAvailable(true)
        XCTAssertEqual(
            registrar.addedDomains.map(\.identifier),
            [FileProviderDomainLifecycle.domainIdentifier])
        XCTAssertTrue(registrar.removedDomains.isEmpty)
        XCTAssertEqual(defaults?.string(forKey: "fileProvider.domainStatus"), "register-succeeded")
    }

    func testMakeDomainDisablesTrash() {
        XCTAssertFalse(FileProviderDomainLifecycle.makeDomain().supportsSyncingTrash)
        XCTAssertFalse(FileProviderDomainLifecycle.needsReset(nil))
        let trashOn = NSFileProviderDomain(
            identifier: FileProviderDomainLifecycle.domainIdentifier,
            displayName: "Sliccy")
        trashOn.supportsSyncingTrash = true
        XCTAssertTrue(FileProviderDomainLifecycle.needsReset(trashOn))
        XCTAssertTrue(
            FileProviderDomainLifecycle.needsReset(FileProviderDomainLifecycle.makeDomain()),
            "Fresh domains report userEnabled=false until the system enables them")
    }

    func testDisabledDomainIsRemovedBeforeReAdd() {
        let registrar = RecordingRegistrar()
        // Fresh NSFileProviderDomain instances report userEnabled=false until
        // the system enables them; that matches the sticky-disabled recovery
        // path we need after SupportsEnumeration was added.
        registrar.knownDomains = [FileProviderDomainLifecycle.makeDomain()]
        let defaults = UserDefaults(suiteName: "fileprovider.lifecycle.tests.\(UUID().uuidString)")
        let lifecycle = FileProviderDomainLifecycle(registrar: registrar, defaults: defaults)

        lifecycle.registerIfCredentialsAvailable(true)

        XCTAssertEqual(registrar.removedDomains.count, 1)
        XCTAssertEqual(registrar.addedDomains.count, 1)
        XCTAssertEqual(defaults?.string(forKey: "fileProvider.domainStatus"), "register-succeeded")
    }

    func testTrashEnabledDomainIsRemovedBeforeReAdd() {
        let registrar = RecordingRegistrar()
        let existing = NSFileProviderDomain(
            identifier: FileProviderDomainLifecycle.domainIdentifier,
            displayName: "Sliccy")
        existing.supportsSyncingTrash = true
        registrar.knownDomains = [existing]
        let defaults = UserDefaults(suiteName: "fileprovider.lifecycle.tests.\(UUID().uuidString)")
        let lifecycle = FileProviderDomainLifecycle(registrar: registrar, defaults: defaults)

        lifecycle.registerIfCredentialsAvailable(true)

        XCTAssertEqual(registrar.removedDomains.count, 1)
        XCTAssertEqual(registrar.addedDomains.count, 1)
        XCTAssertFalse(registrar.addedDomains[0].supportsSyncingTrash)
    }

    func testDuplicateRegistrationAndAbsentRemovalAreHarmless() {
        let registrar = RecordingRegistrar()
        registrar.error = NSFileProviderError(.providerNotFound)
        let defaults = UserDefaults(suiteName: "fileprovider.lifecycle.tests.\(UUID().uuidString)")
        let lifecycle = FileProviderDomainLifecycle(registrar: registrar, defaults: defaults)

        lifecycle.registerIfCredentialsAvailable(true)
        lifecycle.registerIfCredentialsAvailable(true)
        lifecycle.removeDomain()
        lifecycle.removeDomain()

        XCTAssertEqual(registrar.addedDomains.count, 2)
        XCTAssertEqual(registrar.removedDomains.count, 2)
        XCTAssertEqual(defaults?.string(forKey: "fileProvider.domainStatus"), "remove-failed")
    }
}
