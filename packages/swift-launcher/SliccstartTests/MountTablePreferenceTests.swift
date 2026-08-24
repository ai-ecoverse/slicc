import XCTest

@testable import Sliccstart

/// The Settings → Mounts editor text must normalize exactly like
/// swift-server's `ServerConfig.parseMountMapping`, or the UI would show a
/// mapping the server silently drops.
final class MountTablePreferenceTests: XCTestCase {

    private func makeDefaults() -> UserDefaults {
        let suite = "MountTablePreferenceTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    func testParsesMappingsPerLineNormalizedAndDeduplicatedByTarget() {
        let text = """
             /Users/me/proj/ : /mnt/project/ \n
            /Users/me/docs:/mnt/docs
            /Users/me/other:/mnt/project
            relative:/mnt/x
            /mnt/one-sided
            /a:/
            """
        XCTAssertEqual(
            MountTablePreference.mappings(from: text),
            [
                .init(hostPath: "/Users/me/proj", path: "/mnt/project"),
                .init(hostPath: "/Users/me/docs", path: "/mnt/docs"),
            ])
        XCTAssertEqual(
            MountTablePreference.invalidLines(in: text),
            ["relative:/mnt/x", "/mnt/one-sided", "/a:/"])
    }

    func testTildeExpansionAndLastColonSplit() {
        XCTAssertEqual(
            MountTablePreference.mapping(fromLine: "~/proj:/mnt/p", homeDirectory: "/Users/me"),
            .init(hostPath: "/Users/me/proj", path: "/mnt/p"))
        XCTAssertEqual(
            MountTablePreference.mapping(fromLine: "/we:ird/dir:/mnt/x"),
            .init(hostPath: "/we:ird/dir", path: "/mnt/x"))
        XCTAssertNil(MountTablePreference.mapping(fromLine: "~/proj:/mnt/p", homeDirectory: ""))
        XCTAssertNil(MountTablePreference.mapping(fromLine: "/a:/mnt/a/../b"))
        XCTAssertNil(MountTablePreference.mapping(fromLine: "/a:/mnt//b"))
    }

    func testEmptyTextYieldsEmptyTableAndNoArgs() {
        XCTAssertEqual(MountTablePreference.mappings(from: ""), [])
        XCTAssertEqual(MountTablePreference.serverArgs(mappings: []), [])
    }

    func testReadsFromDefaultsAndBuildsServerArgs() {
        let defaults = makeDefaults()
        XCTAssertEqual(MountTablePreference.serverArgs(defaults: defaults), [])
        defaults.set("/h/a:/mnt/a\n/h/b/:/mnt/b", forKey: MountTablePreference.key)
        XCTAssertEqual(
            MountTablePreference.serverArgs(defaults: defaults),
            ["--mount=/h/a:/mnt/a", "--mount=/h/b:/mnt/b"])
    }

    func testEditorTableHelpers() {
        XCTAssertEqual(MountTablePreference.sanitizedFolderName("My Proj:X"), "my-proj-x")
        XCTAssertEqual(MountTablePreference.sanitizedFolderName(""), "folder")
        XCTAssertEqual(
            MountTablePreference.defaultTarget(forFolderNamed: "kb", existing: []), "/mnt/kb")
        XCTAssertEqual(
            MountTablePreference.defaultTarget(forFolderNamed: "kb", existing: ["/mnt/kb"]),
            "/mnt/kb-2")
        XCTAssertEqual(
            MountTablePreference.defaultTarget(forFolderNamed: nil, existing: []), "/mnt/folder")
        XCTAssertTrue(MountTablePreference.isGeneratedDefault("/mnt/folder"))
        XCTAssertTrue(MountTablePreference.isGeneratedDefault("/mnt/folder-3"))
        XCTAssertFalse(MountTablePreference.isGeneratedDefault("/mnt/foldering"))
        XCTAssertFalse(MountTablePreference.isGeneratedDefault("/mnt/kb"))
        XCTAssertTrue(MountTablePreference.isValidTarget("/mnt/kb", among: ["/mnt/kb"]))
        XCTAssertFalse(MountTablePreference.isValidTarget("/mnt/kb", among: ["/mnt/kb", "/mnt/kb"]))
        XCTAssertFalse(MountTablePreference.isValidTarget("relative", among: ["relative"]))
        XCTAssertEqual(MountTablePreference.displayPath("/Users/me/kb", homeDirectory: "/Users/me"), "~/kb")
        XCTAssertEqual(MountTablePreference.displayPath("/Users/me", homeDirectory: "/Users/me"), "~")
        XCTAssertEqual(MountTablePreference.displayPath("/opt/x", homeDirectory: "/Users/me"), "/opt/x")
        XCTAssertEqual(MountTablePreference.displayPath("/opt/x", homeDirectory: ""), "/opt/x")
        XCTAssertEqual(
            MountTablePreference.serialized(rows: [("/h/a", "/mnt/a"), ("", "/mnt/draft"), ("/h/b", "/mnt/b")]),
            "/h/a:/mnt/a\n/h/b:/mnt/b")
        XCTAssertEqual(MountTablePreference.serialized(rows: []), "")
    }
}
