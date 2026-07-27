import XCTest

@testable import Sliccstart

final class SliccCliLocatorTests: XCTestCase {
    private var tempDirectory: URL!

    override func setUpWithError() throws {
        tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempDirectory { try? FileManager.default.removeItem(at: tempDirectory) }
    }

    func testManagedBinaryWinsOverDevelopmentAndPathCandidates() throws {
        let locations = makeLocations()
        let managed = SliccCliLocator.managedBinDirectory(homeDirectory: locations.home)
            .appendingPathComponent("slicc")
        try makeExecutable(at: managed)
        try makeExecutable(at: locations.repository.appendingPathComponent("packages/slicc-cli/bin/slicc"))
        try makeExecutable(at: locations.pathDirectory.appendingPathComponent("slicc"))

        XCTAssertEqual(makeLocator(locations).findCliBinary(), managed.path)
    }

    func testDevelopmentBinWinsOverDistributionCandidate() throws {
        let locations = makeLocations()
        let bin = locations.repository.appendingPathComponent("packages/slicc-cli/bin/slicc")
        let distribution = locations.repository
            .appendingPathComponent("packages/slicc-cli/dist/slicc-darwin-arm64")
        try makeExecutable(at: bin)
        try makeExecutable(at: distribution)

        XCTAssertEqual(makeLocator(locations).findCliBinary(architecture: .arm64), bin.path)
    }

    func testDistributionCandidateWinsOverPathCandidate() throws {
        let locations = makeLocations()
        let distribution = locations.repository
            .appendingPathComponent("packages/slicc-cli/dist/slicc-darwin-amd64")
        try makeExecutable(at: distribution)
        try makeExecutable(at: locations.pathDirectory.appendingPathComponent("slicc"))

        XCTAssertEqual(makeLocator(locations).findCliBinary(architecture: .amd64), distribution.path)
    }

    func testPathDirectoriesKeepDeclaredPriority() throws {
        let locations = makeLocations()
        let first = tempDirectory.appendingPathComponent("first-bin")
        let second = tempDirectory.appendingPathComponent("second-bin")
        try makeExecutable(at: first.appendingPathComponent("slicc"))
        try makeExecutable(at: second.appendingPathComponent("slicc"))
        let locator = SliccCliLocator(
            homeDirectory: locations.home,
            repositoryRoots: [locations.repository],
            pathDirectories: [first, second]
        )

        XCTAssertEqual(locator.findCliBinary(), first.appendingPathComponent("slicc").path)
    }

    func testNonExecutableCandidateIsIgnored() throws {
        let locations = makeLocations()
        let candidate = SliccCliLocator.managedBinDirectory(homeDirectory: locations.home)
            .appendingPathComponent("slicc")
        try createFile(at: candidate)

        XCTAssertNil(makeLocator(locations).findCliBinary())
    }

    func testArchitectureAliasesMapToReleaseNames() {
        XCTAssertEqual(SliccCliArchitecture.from(machine: "arm64"), .arm64)
        XCTAssertEqual(SliccCliArchitecture.from(machine: "aarch64"), .arm64)
        XCTAssertEqual(SliccCliArchitecture.from(machine: "x86_64"), .amd64)
        XCTAssertEqual(SliccCliArchitecture.from(machine: "amd64"), .amd64)
        XCTAssertNil(SliccCliArchitecture.from(machine: "mips"))
    }

    private func makeLocations() -> (home: URL, repository: URL, pathDirectory: URL) {
        (
            tempDirectory.appendingPathComponent("home"),
            tempDirectory.appendingPathComponent("repository"),
            tempDirectory.appendingPathComponent("path-bin")
        )
    }

    private func makeLocator(
        _ locations: (home: URL, repository: URL, pathDirectory: URL)
    ) -> SliccCliLocator {
        SliccCliLocator(
            homeDirectory: locations.home,
            repositoryRoots: [locations.repository],
            pathDirectories: [locations.pathDirectory]
        )
    }

    private func makeExecutable(at url: URL) throws {
        try createFile(at: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    private func createFile(at url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("binary".utf8).write(to: url)
    }
}
