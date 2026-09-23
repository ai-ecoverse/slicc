import XCTest

@testable import Sliccstart




final class ComputerCapabilityAdvertisementTests: XCTestCase {
    private func grants(screen: Bool, axe: Bool) -> ComputerGrants {
        ComputerGrants(screenRecording: screen, accessibility: axe)
    }

    func testCaptureClaimFollowsTheScreenRecordingGrantAlone() {
        XCTAssertTrue(grants(screen: true, axe: true).canCaptureNatively)
        XCTAssertTrue(grants(screen: true, axe: false).canCaptureNatively)
        XCTAssertFalse(grants(screen: false, axe: true).canCaptureNatively)
        XCTAssertFalse(grants(screen: false, axe: false).canCaptureNatively)

        let denied = ComputerCapabilityAdvertisement.capabilities(
            for: grants(screen: false, axe: true))
        XCTAssertEqual(denied.computer, false)
        XCTAssertEqual(denied.exec, false, "shell-out stays on `slicc … follow`")
    }

    
    
    func testEveryDeniedCombinationNamesTheGrantAndSystemSettings() {
        let host = "studio.local"

        let both = ComputerCapabilityAdvertisement.motd(
            host: host, grants: grants(screen: true, axe: true))
        XCTAssertEqual(both, "Native screen capture on \(host)")
        XCTAssertFalse(both.contains("System Settings"), "nothing to ask for")

        for (screen, axe, expected) in [
            (true, false, ["Accessibility"]),
            (false, true, ["Screen Recording"]),
            (false, false, ["Screen Recording", "Accessibility"]),
        ] {
            let motd = ComputerCapabilityAdvertisement.motd(
                host: host, grants: grants(screen: screen, axe: axe))
            XCTAssertTrue(motd.contains(host), motd)
            XCTAssertTrue(motd.contains("System Settings"), motd)
            for grant in expected { XCTAssertTrue(motd.contains(grant), motd) }
        }
    }

    
    
    func testGrantsReadTheProbeWithoutRequesting() {
        var requests = 0
        let probe = ComputerPermissionProbe(
            screenRecordingGranted: { true },
            requestScreenRecording: {
                requests += 1
                return true
            },
            accessibilityGranted: { false },
            requestAccessibility: {
                requests += 1
                return true
            })

        let read = ComputerPermissions(probe: probe).grants()

        XCTAssertEqual(read, grants(screen: true, axe: false))
        XCTAssertEqual(requests, 0)
    }
}
