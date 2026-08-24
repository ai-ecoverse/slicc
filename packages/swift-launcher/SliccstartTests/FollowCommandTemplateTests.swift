import XCTest

@testable import Sliccstart

final class FollowCommandTemplateTests: XCTestCase {
    func testDefaultTemplateExpandsAllPlaceholders() {
        let command = FollowCommandTemplate.expand(
            template: FollowCommandTemplate.defaultTemplate,
            sliccPath: "/Applications/Slicc/slicc",
            joinURL: "https://www.sliccy.ai/join/tray.secret",
            shellPath: "/bin/fish"
        )

        XCTAssertEqual(
            command,
            "/Applications/Slicc/slicc https://www.sliccy.ai/join/tray.secret follow /bin/fish -c"
        )
    }

    func testCustomTemplateExpandsRepeatedPlaceholders() {
        let command = FollowCommandTemplate.expand(
            template: "{shell} -lc '{slicc} {joinUrl} follow {shell} -c'",
            sliccPath: "slicc-bin",
            joinURL: "join-url",
            shellPath: "/bin/zsh"
        )

        XCTAssertEqual(command, "/bin/zsh -lc 'slicc-bin join-url follow /bin/zsh -c'")
    }

    func testExpansionQuotesPlaceholderValuesForTheShell() {
        let command = FollowCommandTemplate.expand(
            template: FollowCommandTemplate.defaultTemplate,
            sliccPath: "/Users/O'Brien/Library/Application Support/Sliccstart/bin/slicc",
            joinURL: "https://example.com/join/id?token=a&b",
            shellPath: "/bin/zsh"
        )

        XCTAssertEqual(
            command,
            "'/Users/O'\"'\"'Brien/Library/Application Support/Sliccstart/bin/slicc' "
                + "'https://example.com/join/id?token=a&b' follow /bin/zsh -c"
        )
    }

    func testEmptyTemplateFallsBackToDefault() {
        let command = FollowCommandTemplate.expand(
            template: "  \n",
            sliccPath: "slicc",
            joinURL: "join-url",
            shellPath: "/bin/zsh"
        )

        XCTAssertEqual(command, "slicc join-url follow /bin/zsh -c")
    }

    func testTemplateMissingJoinURLFallsBackToDefault() {
        let command = FollowCommandTemplate.expand(
            template: "{slicc} follow {shell} -c",
            sliccPath: "slicc",
            joinURL: "join-url",
            shellPath: "/bin/zsh"
        )

        XCTAssertEqual(command, "slicc join-url follow /bin/zsh -c")
    }

    func testPreviewUsesRedactedJoinURL() {
        let secret = "tray.super-secret-value"
        let preview = FollowCommandTemplate.preview(
            template: "{slicc} {joinUrl} follow {shell} -c",
            sliccPath: "slicc",
            shellPath: "/bin/zsh"
        )

        XCTAssertTrue(preview.contains(FollowCommandTemplate.redactedJoinURL))
        XCTAssertFalse(preview.contains(secret))
        XCTAssertFalse(preview.contains("super-secret-value"))
    }

    @MainActor
    func testTerminalsSettingsViewBodyBuilds() {
        // Walks the SwiftUI body so the pane's template → preview path is
        // covered; the view itself is not otherwise exercised by `swift test`.
        _ = TerminalsSettingsView().body
    }
}
