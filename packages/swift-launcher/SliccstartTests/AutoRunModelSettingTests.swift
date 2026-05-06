import Foundation
import XCTest
@testable import Sliccstart

/// Pins the auto-run-on-launch contract for the Models tab.
///
/// The Models tab writes a HuggingFace `repoId` (or empty string for
/// "None") to UserDefaults under `autoRunModelIdKey`. `SliccstartApp`
/// reads that key on launch and starts the model, but only when the
/// hardware can plausibly host it AND the model is still in the cache.
/// These tests pin the storage shape so the picker, the launcher, and
/// any future migration agree on what the saved value means.
final class AutoRunModelSettingTests: XCTestCase {

    /// The key name is what users' UserDefaults blobs are keyed by
    /// (and what synced settings will carry across machines), so it
    /// can't be silently renamed without a migration. Pin it here.
    func testAutoRunModelIdKeyIsStable() {
        XCTAssertEqual(autoRunModelIdKey, "autoRunModelId")
    }

    /// The empty string is the canonical "no auto-run" value. It must
    /// not collide with any real HF `repoId` (which always contain `/`).
    func testEmptyStringMeansNone() {
        XCTAssertFalse(autoRunModelIdKey.isEmpty)
        // No HF repoId is empty or unslashed; the picker uses "" as the
        // None tag specifically because it can't shadow a real entry.
        let exampleRepoIds = SuggestedModels.all.map { $0.repoId }
        for repoId in exampleRepoIds {
            XCTAssertFalse(repoId.isEmpty)
            XCTAssertTrue(repoId.contains("/"), "Empty-string sentinel would shadow \(repoId)")
        }
    }

    /// Auto-run keys for the browser and the local model live side by
    /// side in the same UserDefaults; a copy-paste rename must not
    /// collapse them onto the same key (which would have one setting
    /// silently overwrite the other).
    func testAutoRunAndAutoLaunchKeysAreDistinct() {
        XCTAssertNotEqual(autoRunModelIdKey, autoLaunchAppIdKey)
    }

    /// A 64 GiB floor gates the Models *tab* (see
    /// `LocalModelsAvailabilityTests`); the same threshold MUST gate
    /// auto-run, otherwise a UserDefaults blob synced from a workstation
    /// to a laptop would trigger a multi-GB download + 18 GB load on
    /// hardware that can't run it. Pin the symmetry.
    func testAutoRunGateMatchesModelsTabGate() {
        let oneGiB: UInt64 = 1024 * 1024 * 1024
        XCTAssertFalse(LocalModelsAvailability.isSupported(physicalMemoryBytes: 16 * oneGiB))
        XCTAssertFalse(LocalModelsAvailability.isSupported(physicalMemoryBytes: 32 * oneGiB))
        XCTAssertTrue(LocalModelsAvailability.isSupported(physicalMemoryBytes: 64 * oneGiB))
    }
}
