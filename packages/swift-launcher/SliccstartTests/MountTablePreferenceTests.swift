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
}
