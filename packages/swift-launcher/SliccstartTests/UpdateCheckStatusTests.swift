import AppUpdater
import XCTest

@testable import Sliccstart




final class UpdateCheckStatusTests: XCTestCase {

    func testCancelledErrorMeansUpToDate() {
        XCTAssertEqual(UpdateCheckStatus.from(error: AUError.cancelled), .upToDate)
    }

    func testNoValidUpdateMeansNoInstallableRelease() {
        XCTAssertEqual(
            UpdateCheckStatus.from(error: AppUpdater.Error.noValidUpdate),
            .noInstallableRelease
        )
    }

    func testURLErrorSurfacesLocalizedDescription() {
        let error = URLError(.badServerResponse)
        XCTAssertEqual(UpdateCheckStatus.from(error: error), .failed(error.localizedDescription))
    }

    func testUnknownErrorSurfacesDescription() {
        struct Boom: Error {}
        XCTAssertEqual(UpdateCheckStatus.from(error: Boom()), .failed("Boom()"))
    }

    func testCodeSigningMismatchIsReportedAsFailure() {
        guard case .failed = UpdateCheckStatus.from(error: AppUpdater.Error.codeSigningIdentity) else {
            return XCTFail("A code-signing mismatch must be visible, not silent")
        }
    }

    
    
    
    
    func testReadOnlyVolumeErrorMeansTranslocated() {
        let error = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteVolumeReadOnlyError)
        XCTAssertEqual(UpdateCheckStatus.from(error: error), .translocated)
    }

    func testUnrelatedCocoaErrorIsStillReportedAsFailure() {
        let error = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError)
        guard case .failed = UpdateCheckStatus.from(error: error) else {
            return XCTFail("A non-read-only Cocoa error must not be mistaken for translocation")
        }
    }

    func testButtonTitlesAreDistinct() {
        let titles = [
            UpdateCheckStatus.idle,
            .checking,
            .upToDate,
            .noInstallableRelease,
            .translocated,
            .failed("nope"),
        ].map(\.buttonTitle)
        XCTAssertEqual(Set(titles).count, titles.count)
    }

    func testOnlyInFlightCheckBlocksRetry() {
        XCTAssertFalse(UpdateCheckStatus.checking.allowsRetry)
        XCTAssertTrue(UpdateCheckStatus.idle.allowsRetry)
        XCTAssertTrue(UpdateCheckStatus.upToDate.allowsRetry)
        XCTAssertTrue(UpdateCheckStatus.noInstallableRelease.allowsRetry)
        XCTAssertTrue(UpdateCheckStatus.translocated.allowsRetry)
        XCTAssertTrue(UpdateCheckStatus.failed("x").allowsRetry)
    }

    func testFailureDetailIncludesTheUnderlyingMessage() {
        XCTAssertEqual(UpdateCheckStatus.failed("rate limited").detail, "rate limited Click to try again.")
        XCTAssertNil(UpdateCheckStatus.idle.detail)
        XCTAssertNil(UpdateCheckStatus.checking.detail)
        XCTAssertNotNil(UpdateCheckStatus.upToDate.detail)
        XCTAssertNotNil(UpdateCheckStatus.noInstallableRelease.detail)
        XCTAssertNotNil(UpdateCheckStatus.translocated.detail)
    }
}
