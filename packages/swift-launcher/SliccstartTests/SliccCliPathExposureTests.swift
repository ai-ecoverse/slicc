import XCTest

@testable import Sliccstart

final class SliccCliPathExposureTests: XCTestCase {
    private var homeDirectory: URL!

    override func setUpWithError() throws {
        homeDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: homeDirectory, withIntermediateDirectories: true)
        try makeManagedBinary()
    }

    override func tearDownWithError() throws {
        if let homeDirectory { try? FileManager.default.removeItem(at: homeDirectory) }
    }

    func testCreatesLocalBinDirectoryAndSymlink() throws {
        XCTAssertEqual(exposure().expose(managedBinary), .created)
        XCTAssertEqual(try linkDestination(), managedBinary.path)
    }

    func testAlreadyCorrectSymlinkIsUnchanged() throws {
        try makeLink(to: managedBinary)

        XCTAssertEqual(exposure().expose(managedBinary), .alreadyCorrect)
        XCTAssertEqual(try linkDestination(), managedBinary.path)
    }

    func testRepointsSymlinkFromPreviousManagedPath() throws {
        let oldManagedBinary = managedRoot.appendingPathComponent("versions/old/slicc")
        try makeLink(to: oldManagedBinary)

        XCTAssertEqual(exposure().expose(managedBinary), .repointed)
        XCTAssertEqual(try linkDestination(), managedBinary.path)
    }

    func testPreservesUnrelatedUserSymlink() throws {
        let userBinary = homeDirectory.appendingPathComponent("user-tools/slicc")
        try makeLink(to: userBinary)

        XCTAssertEqual(exposure().expose(managedBinary), .preservedExisting)
        XCTAssertEqual(try linkDestination(), userBinary.path)
    }

    func testPreservesPreExistingRegularFile() throws {
        try FileManager.default.createDirectory(at: localBin, withIntermediateDirectories: true)
        try Data("user-installed".utf8).write(to: link)

        XCTAssertEqual(exposure().expose(managedBinary), .preservedExisting)
        XCTAssertEqual(try Data(contentsOf: link), Data("user-installed".utf8))
    }

    func testUnwritableTargetDirectoryIsNonFatal() {
        let result = exposure(isWritable: { _ in false }).expose(managedBinary)

        XCTAssertEqual(result, .failed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: link.path))
    }

    func testNonManagedBinaryDoesNotChangePath() {
        let userBinary = URL(fileURLWithPath: "/usr/local/bin/slicc")

        XCTAssertEqual(exposure().expose(userBinary), .skippedNonManaged)
        XCTAssertFalse(FileManager.default.fileExists(atPath: localBin.path))
    }

    private var managedRoot: URL {
        homeDirectory.appendingPathComponent("Library/Application Support/Sliccstart")
    }

    private var managedBinary: URL {
        SliccCliLocator.managedBinDirectory(homeDirectory: homeDirectory).appendingPathComponent("slicc")
    }

    private var localBin: URL { homeDirectory.appendingPathComponent(".local/bin") }
    private var link: URL { localBin.appendingPathComponent("slicc") }

    private func exposure(
        isWritable: @escaping (String) -> Bool = FileManager.default.isWritableFile(atPath:)
    ) -> SliccCliPathExposure {
        SliccCliPathExposure(homeDirectory: homeDirectory, isDirectoryWritable: isWritable)
    }

    private func makeManagedBinary() throws {
        try FileManager.default.createDirectory(
            at: managedBinary.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("managed".utf8).write(to: managedBinary)
    }

    private func makeLink(to destination: URL) throws {
        try FileManager.default.createDirectory(at: localBin, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: destination)
    }

    private func linkDestination() throws -> String {
        try FileManager.default.destinationOfSymbolicLink(atPath: link.path)
    }
}
