import XCTest

@testable import SliccTrayKit



final class TrayKitVFSReexportTests: XCTestCase {
    func testSharedVFSTypesAreVisibleThroughTrayKit() {
        _ = FsClient.self
        _ = LeaderVFSProvider.self
        _ = FileProviderDomainLifecycle.self
        _ = TrayCredentialStore.self
    }
}
