import XCTest

@testable import SliccTrayKit

/// Guard `TrayVFSExports.swift` — shared VFS types must stay visible through
/// `import SliccTrayKit` for the app, File Provider appex, and unit tests.
final class TrayKitVFSReexportTests: XCTestCase {
    func testSharedVFSTypesAreVisibleThroughTrayKit() {
        _ = FsClient.self
        _ = LeaderVFSProvider.self
        _ = FileProviderDomainLifecycle.self
        _ = TrayCredentialStore.self
    }
}
