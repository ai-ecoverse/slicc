import XCTest

@testable import SliccFollower

@MainActor
final class ChatPresentationStateTests: XCTestCase {

    func testSurfaceAndDraftSurviveBothLayoutTransitions() {
        let state = ChatPresentationState()
        state.activeSurface = .browser
        state.composerDraft = "Keep this unfinished thought"

        for mode in [ShellLayoutMode.regularSplit, .compactOverlay] {
            XCTAssertEqual(state.activeSurface, .browser, "\(mode) must reuse shell state")
            XCTAssertEqual(
                state.composerDraft, "Keep this unfinished thought",
                "\(mode) must reuse shell state")
        }
    }
}
