import XCTest

@testable import Sliccstart

/// Guards the cheap running-app matcher that replaced a per-app
/// `resolvingSymlinksInPath()` scan (~35% main-thread CPU every 2s).
final class ElectronAppMatchingTests: XCTestCase {
    func testCandidatePathsIncludeRawStandardizedAndResolvedSpellings() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("slicc-match-\(UUID().uuidString)")
        let real = dir.appendingPathComponent("Real.app")
        let link = dir.appendingPathComponent("Link.app")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }

        let candidates = SliccProcess.candidateBundlePaths(for: [link.path + "/"])
        XCTAssertTrue(candidates.contains(link.path), "raw (trailing slash stripped)")
        XCTAssertTrue(
            candidates.contains(real.resolvingSymlinksInPath().path),
            "symlink-resolved spelling is present so LaunchServices' canonical bundleURL matches"
        )
    }

    func testAppMatchesByBundlePathOrExecutablePrefixWithoutTouchingDisk() {
        let candidates = SliccProcess.candidateBundlePaths(for: ["/Applications/Does-Not-Exist.app"])
        XCTAssertTrue(
            SliccProcess.appMatches(
                bundlePath: "/Applications/Does-Not-Exist.app/", executablePath: nil,
                candidateBundlePaths: candidates))
        XCTAssertTrue(
            SliccProcess.appMatches(
                bundlePath: nil,
                executablePath: "/Applications/Does-Not-Exist.app/Contents/MacOS/Thing",
                candidateBundlePaths: candidates))
        XCTAssertFalse(
            SliccProcess.appMatches(
                bundlePath: "/Applications/Does-Not-Exist.app Helper.app",
                executablePath: "/Applications/Does-Not-Exist.app-other/Contents/MacOS/Thing",
                candidateBundlePaths: candidates))
        XCTAssertFalse(
            SliccProcess.appMatches(
                bundlePath: nil, executablePath: nil, candidateBundlePaths: candidates))
    }
}
