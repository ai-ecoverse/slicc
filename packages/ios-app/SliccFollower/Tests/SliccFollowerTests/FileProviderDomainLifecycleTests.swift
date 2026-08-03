import FileProvider
import XCTest

@testable import SliccFollower

@MainActor
final class FileProviderDomainLifecycleTests: XCTestCase {
    private final class RecordingRegistrar: FileProviderDomainRegistering {
        var addedDomains: [NSFileProviderDomain] = []
        var removedDomains: [NSFileProviderDomain] = []
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
    }

    func testRegistrationRequiresCredentials() {
        let registrar = RecordingRegistrar()
        let lifecycle = FileProviderDomainLifecycle(registrar: registrar)

        lifecycle.registerIfCredentialsAvailable(false)
        XCTAssertTrue(registrar.addedDomains.isEmpty)

        lifecycle.registerIfCredentialsAvailable(true)
        XCTAssertEqual(registrar.addedDomains.map(\.identifier), [FileProviderDomainLifecycle.domain.identifier])
    }

    func testDuplicateRegistrationAndAbsentRemovalAreHarmless() {
        let registrar = RecordingRegistrar()
        registrar.error = NSFileProviderError(.providerNotFound)
        let lifecycle = FileProviderDomainLifecycle(registrar: registrar)

        lifecycle.registerIfCredentialsAvailable(true)
        lifecycle.registerIfCredentialsAvailable(true)
        lifecycle.removeDomain()
        lifecycle.removeDomain()

        XCTAssertEqual(registrar.addedDomains.count, 2)
        XCTAssertEqual(registrar.removedDomains.count, 2)
    }
}
