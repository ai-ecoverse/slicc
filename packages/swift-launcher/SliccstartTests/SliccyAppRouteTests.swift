import XCTest

@testable import Sliccstart

final class SliccyAppRouteTests: XCTestCase {
    private let sliccy = URL(fileURLWithPath: "/Applications/Sliccy.app")
    private let oldApp = URL(fileURLWithPath: "/Applications/Sliccstart.app")
    private var discovered: [URL] = []
    private var missing = false
    private var invalid = false
    private var launched = false
    private var running = true
    private var failLaunch = false
    private var failOldSignature = false
    private var revealed: [URL] = []
    private var context: SliccstartRemovalContext!

    override func setUp() {
        discovered = []
        missing = false
        invalid = false
        launched = false
        running = true
        failLaunch = false
        failOldSignature = false
        revealed = []
        context = removalContext()
    }

    private func removalContext(
        url: URL? = nil, id: String = "com.slicc.sliccstart", directory: Bool = true,
        readOnly: Bool = false, writable: Bool = true, development: Bool = false
    ) -> SliccstartRemovalContext {
        .init(url: url ?? oldApp, bundleIdentifier: id, isDirectory: directory, isReadOnly: readOnly, isWritable: writable, isDevelopment: development)
    }

    private func services() -> SliccyAppRoute.Services {
        var services = SliccyAppRoute.Services()
        services.discover = { [self] in discovered }
        services.exists = { [self] _ in !missing }
        services.validate = { [self] url in
            if invalid { throw SliccyRouteError.unsuitableApp }
            return SliccyApplication(url: url, version: url.lastPathComponent.contains("7.1") ? "7.1.0" : "7.0.0")
        }
        services.launch = { [self] url in
            XCTAssertEqual(url, sliccy)
            launched = true
            return !failLaunch
        }
        services.isRunning = { [self] _ in running }
        services.removalContext = { [self] in context }
        services.validateOldApp = { [self] _ in if failOldSignature { throw SliccyRouteError.removalUnavailable } }
        services.reveal = { [self] url in
            revealed.append(url)
            return true
        }
        return services
    }

    func testMissingAndStaleDiscoveryReturnNoAppWithoutLaunching() async throws {
        let first = try await SliccyAppRoute(services: services()).discover()
        XCTAssertNil(first)
        discovered = [sliccy]
        missing = true
        let stale = try await SliccyAppRoute(services: services()).discover()
        XCTAssertNil(stale)
        XCTAssertFalse(launched)
        XCTAssertTrue(revealed.isEmpty)
    }

    func testNativeCandidatesSelectNewestSuitableVersionWithoutLaunching() async throws {
        discovered = [sliccy, URL(fileURLWithPath: "/Applications/Sliccy 7.1.app")]
        let result = try await SliccyAppRoute(services: services()).discover()
        XCTAssertEqual(result?.version, "7.1.0")
        XCTAssertFalse(launched)
    }

    func testInvalidAppCannotBeOfferedOrLaunched() async {
        discovered = [sliccy]
        invalid = true
        do {
            _ = try await SliccyAppRoute(services: services()).discover()
            XCTFail("invalid discovery")
        } catch {}
        do {
            _ = try await SliccyAppRoute(services: services()).open(sliccy)
            XCTFail("invalid launch")
        } catch {}
        XCTAssertFalse(launched)
        XCTAssertTrue(revealed.isEmpty)
    }

    func testLaunchRequiresBothNativeCompletionAndRunningConfirmation() async throws {
        failLaunch = true
        do {
            _ = try await SliccyAppRoute(services: services()).open(sliccy)
            XCTFail("failed launch")
        } catch {}
        failLaunch = false
        running = false
        do {
            _ = try await SliccyAppRoute(services: services()).open(sliccy)
            XCTFail("not running")
        } catch {}
        running = true
        let opened = try await SliccyAppRoute(services: services()).open(sliccy)
        XCTAssertEqual(opened.url, sliccy)
        XCTAssertTrue(revealed.isEmpty, "launch must never remove/reveal the old app")
    }

    func testRemovalNeedsVerifiedRunningSliccy() async {
        running = false
        do {
            _ = try await SliccyAppRoute(services: services()).revealOldApp(afterLaunching: sliccy)
            XCTFail("not running")
        } catch {}
        running = true
        invalid = true
        do {
            _ = try await SliccyAppRoute(services: services()).revealOldApp(afterLaunching: sliccy)
            XCTFail("invalid app")
        } catch {}
        XCTAssertTrue(revealed.isEmpty)
    }

    func testRemovalRejectsUnsafeOldAppContextsWithoutRevealingAnything() async {
        let unsafe = [
            removalContext(id: "ai.sliccy.mac"), removalContext(directory: false), removalContext(readOnly: true),
            removalContext(writable: false), removalContext(development: true),
            removalContext(url: URL(fileURLWithPath: "/Volumes/Sliccstart/Sliccstart.app")),
            removalContext(url: URL(fileURLWithPath: "/tmp/build/Sliccstart.app")),
            removalContext(url: URL(fileURLWithPath: "/ApplicationsOld/Sliccstart.app")),
            removalContext(url: URL(fileURLWithPath: "/Applications/folder")),
        ]
        for candidate in unsafe {
            context = candidate
            do {
                _ = try await SliccyAppRoute(services: services()).revealOldApp(afterLaunching: sliccy)
                XCTFail("unsafe context")
            } catch {}
        }
        XCTAssertTrue(revealed.isEmpty)
    }

    func testOldAppSignatureFailureAndChangedContextPreventReveal() async {
        failOldSignature = true
        do {
            _ = try await SliccyAppRoute(services: services()).revealOldApp(afterLaunching: sliccy)
            XCTFail("old app signature")
        } catch {}
        failOldSignature = false
        var service = services()
        var reads = 0
        service.removalContext = { [self] in
            reads += 1
            return reads == 1 ? context : removalContext(readOnly: true)
        }
        do {
            _ = try await SliccyAppRoute(services: service).revealOldApp(afterLaunching: sliccy)
            XCTFail("context changed")
        } catch {}
        XCTAssertTrue(revealed.isEmpty)
    }

    func testSliccyExitWhilePreparingRemovalPreventsReveal() async {
        var service = services()
        service.validateOldApp = { [self] _ in running = false }
        do {
            _ = try await SliccyAppRoute(services: service).revealOldApp(afterLaunching: sliccy)
            XCTFail("Sliccy exited")
        } catch {}
        XCTAssertTrue(revealed.isEmpty)
    }

    func testTargetDisappearingWhilePreparingRemovalPreventsReveal() async {
        var service = services()
        service.validateOldApp = { [self] _ in invalid = true }
        do {
            _ = try await SliccyAppRoute(services: service).revealOldApp(afterLaunching: sliccy)
            XCTFail("Sliccy disappeared")
        } catch {}
        XCTAssertTrue(revealed.isEmpty)
    }

    func testFinderFailureIsReportedWithoutClaimingRemoval() async {
        var service = services()
        service.reveal = { _ in false }
        do {
            _ = try await SliccyAppRoute(services: service).revealOldApp(afterLaunching: sliccy)
            XCTFail("Finder failed")
        } catch SliccyRouteError.revealFailed(let url) { XCTAssertEqual(url, oldApp) } catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertTrue(revealed.isEmpty)
    }

    func testRemovalOnlyRevealsExactRunningOldBundle() async throws {
        let selected = try await SliccyAppRoute(services: services()).revealOldApp(afterLaunching: sliccy)
        XCTAssertEqual(selected, oldApp)
        XCTAssertEqual(revealed, [oldApp])
        XCTAssertFalse(launched, "removal must not create a new app process implicitly")
    }

    func testInstallationLocationPolicyRejectsPrefixLookalikesAndDiskImages() {
        XCTAssertTrue(SliccyApplicationValidator.isInstalledLocation(sliccy))
        XCTAssertFalse(SliccyApplicationValidator.isInstalledLocation(URL(fileURLWithPath: "/ApplicationsOld/Sliccy.app")))
        XCTAssertFalse(SliccyApplicationValidator.isInstalledLocation(URL(fileURLWithPath: "/Volumes/Installer/Sliccy.app")))
    }
}
