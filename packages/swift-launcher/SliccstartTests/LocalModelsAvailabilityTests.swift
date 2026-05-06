import XCTest
@testable import Sliccstart

/// Pins the 64 GB threshold used to gate the Models tab in
/// `SettingsView`. The suggested local-LLM catalog needs 14–18 GB
/// just for the weights, so machines below this floor get the tab
/// hidden rather than a UI that promises models the hardware can't
/// run. `ProcessInfo.physicalMemory` reports binary bytes; the
/// boundary cases here use the same `64 * 1024^3` value.
final class LocalModelsAvailabilityTests: XCTestCase {

    func testRejectsCommonLowMemoryConfigs() {
        let oneGiB: UInt64 = 1024 * 1024 * 1024
        XCTAssertFalse(LocalModelsAvailability.isSupported(physicalMemoryBytes: 8 * oneGiB))
        XCTAssertFalse(LocalModelsAvailability.isSupported(physicalMemoryBytes: 16 * oneGiB))
        XCTAssertFalse(LocalModelsAvailability.isSupported(physicalMemoryBytes: 24 * oneGiB))
        XCTAssertFalse(LocalModelsAvailability.isSupported(physicalMemoryBytes: 32 * oneGiB))
        XCTAssertFalse(LocalModelsAvailability.isSupported(physicalMemoryBytes: 36 * oneGiB))
        XCTAssertFalse(LocalModelsAvailability.isSupported(physicalMemoryBytes: 48 * oneGiB))
    }

    func testAcceptsAtAndAboveThreshold() {
        let oneGiB: UInt64 = 1024 * 1024 * 1024
        XCTAssertTrue(LocalModelsAvailability.isSupported(physicalMemoryBytes: 64 * oneGiB))
        XCTAssertTrue(LocalModelsAvailability.isSupported(physicalMemoryBytes: 96 * oneGiB))
        XCTAssertTrue(LocalModelsAvailability.isSupported(physicalMemoryBytes: 128 * oneGiB))
        XCTAssertTrue(LocalModelsAvailability.isSupported(physicalMemoryBytes: 192 * oneGiB))
    }

    /// One byte either side of the 64 GiB boundary, to lock in that the
    /// comparison is `>=` and that nobody quietly switches to decimal GB
    /// (which would reduce the threshold to ~59.6 GiB).
    func testBoundaryIsExactly64GiB() {
        let threshold = LocalModelsAvailability.minimumPhysicalMemoryBytes
        XCTAssertEqual(threshold, 68_719_476_736)
        XCTAssertFalse(LocalModelsAvailability.isSupported(physicalMemoryBytes: threshold - 1))
        XCTAssertTrue(LocalModelsAvailability.isSupported(physicalMemoryBytes: threshold))
        XCTAssertTrue(LocalModelsAvailability.isSupported(physicalMemoryBytes: threshold + 1))
    }
}
