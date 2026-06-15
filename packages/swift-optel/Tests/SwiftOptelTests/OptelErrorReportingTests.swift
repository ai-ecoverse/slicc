import XCTest
@testable import SwiftOptel

private struct FixedRandomSource: RandomSource {
    let value: Double
    func nextUnitDouble() -> Double { value }
}

private enum SampleError: Error {
    case missingField
}

private struct DomainError: CustomNSError {
    static var errorDomain: String { "io.acme.network" }
    var errorCode: Int { 503 }
    var errorUserInfo: [String: Any] {
        [NSLocalizedDescriptionKey: "Service unavailable"]
    }
}

final class OptelErrorReportingTests: XCTestCase {
    private let baseURL = URL(string: "https://rum.hlx.page/")!

    func testErrorMappingUsesBridgedDomainAndDescription() {
        let mapping = OptelErrorMapping.from(error: DomainError())
        XCTAssertEqual(mapping.source, "io.acme.network")
        XCTAssertEqual(mapping.target, "Service unavailable")
    }

    func testErrorMappingForPlainSwiftErrorUsesBridgedDomain() {
        let mapping = OptelErrorMapping.from(error: SampleError.missingField)
        // Plain Swift error enums bridge to a domain of `<Module>.<TypeName>`.
        XCTAssertTrue(
            mapping.source.contains("SampleError"),
            "expected source to mention the type name, got \(mapping.source)"
        )
        XCTAssertFalse(mapping.target.isEmpty)
    }

    func testExceptionMappingUsesNameAndReason() {
        let exception = NSException(
            name: NSExceptionName("OptelDemoException"),
            reason: "synthetic",
            userInfo: nil
        )
        let mapping = OptelErrorMapping.from(exception: exception)
        XCTAssertEqual(mapping.source, "OptelDemoException")
        XCTAssertEqual(mapping.target, "synthetic")
    }

    func testExceptionMappingFallsBackToDescriptionWhenReasonIsBlank() {
        let exception = NSException(
            name: NSExceptionName("OptelDemoException"),
            reason: "  ",
            userInfo: nil
        )
        let mapping = OptelErrorMapping.from(exception: exception)
        XCTAssertEqual(mapping.source, "OptelDemoException")
        XCTAssertFalse(mapping.target.isEmpty)
    }

    func testReportErrorEmitsErrorCheckpoint() {
        let mock = RecordingTransport()
        let optel = Optel()
        optel.configure(
            appID: "com.example.app",
            rate: "on",
            collectBaseURL: baseURL,
            transport: mock,
            randomSource: FixedRandomSource(value: 0)
        )

        optel.reportError(DomainError())

        XCTAssertEqual(mock.sent.map { $0.event.checkpoint.rawValue }, ["top", "error"])
        let errorBeacon = mock.sent[1].event
        XCTAssertEqual(errorBeacon.pingData.source, "io.acme.network")
        XCTAssertEqual(errorBeacon.pingData.target, "Service unavailable")
        XCTAssertNil(errorBeacon.pingData.value)
        XCTAssertEqual(errorBeacon.referer, "https://com.example.app/")
    }

    func testUncaughtHookInstallIsIdempotent() {
        OptelUncaughtExceptionHook._testing_reset()
        XCTAssertFalse(OptelUncaughtExceptionHook.isInstalled)
        OptelUncaughtExceptionHook.installIfNeeded()
        XCTAssertTrue(OptelUncaughtExceptionHook.isInstalled)
        // Second call is a no-op; must not crash and the flag must remain set.
        OptelUncaughtExceptionHook.installIfNeeded()
        XCTAssertTrue(OptelUncaughtExceptionHook.isInstalled)
    }
}
