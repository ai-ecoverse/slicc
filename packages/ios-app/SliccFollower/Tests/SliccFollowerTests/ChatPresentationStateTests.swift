import SwiftUI
import XCTest

@testable import SliccFollower

@MainActor
final class ChatPresentationStateTests: XCTestCase {

    func testShellOwnerSurvivesMultitaskingLayoutTransitions() throws {
        let steps: [LayoutStep] = [
            .init(name: "Slide Over", sizeClass: .compact, width: 320, mode: .compactOverlay),
            .init(name: "Split View at boundary", sizeClass: .regular, width: 560, mode: .compactOverlay),
            .init(name: "Split View above boundary", sizeClass: .regular, width: 561, mode: .regularSplit),
            .init(name: "Full Screen", sizeClass: .regular, width: 1_024, mode: .regularSplit),
            .init(name: "Back above boundary", sizeClass: .regular, width: 561, mode: .regularSplit),
            .init(name: "Back at boundary", sizeClass: .regular, width: 560, mode: .compactOverlay),
            .init(name: "Back to Slide Over", sizeClass: .compact, width: 320, mode: .compactOverlay),
        ]
        var constructedOwners: [ChatPresentationState] = []
        func makeState() -> ChatPresentationState {
            let state = ChatPresentationState()
            constructedOwners.append(state)
            return state
        }
        let appState = AppState()
        func root(for step: LayoutStep) -> AnyView {
            AnyView(
                ChatView(presentation: makeState())
                    .environment(\.horizontalSizeClass, step.sizeClass)
                    .environmentObject(appState)
                    .frame(width: step.width, height: 768)
            )
        }

        let initialStep = steps[0]
        let host = UIHostingController(rootView: root(for: initialStep))
        let window = UIWindow(
            frame: CGRect(x: 0, y: 0, width: initialStep.width, height: 768))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        render(window, host: host, step: initialStep)
        XCTAssertEqual(constructedOwners.count, 1, "ChatView must construct one shell owner")
        let owner = try XCTUnwrap(constructedOwners.first)
        let ownerIdentity = ObjectIdentifier(owner)
        owner.activeSurface = .browser
        owner.composerDraft = "Keep this unfinished thought"
        owner.transcriptPosition.scrollTo(id: "message-42", anchor: .center)

        for (index, step) in steps.enumerated() {
            XCTAssertEqual(
                ShellLayout.mode(
                    horizontalSizeClass: step.sizeClass,
                    availableWidth: step.width),
                step.mode,
                "\(step.name) must exercise the expected adaptive branch")
            if index > 0 {
                host.rootView = root(for: step)
                render(window, host: host, step: step)
            }

            XCTAssertEqual(constructedOwners.count, 1, "\(step.name) must not construct branch state")
            XCTAssertEqual(ObjectIdentifier(constructedOwners[0]), ownerIdentity)
            XCTAssertEqual(owner.activeSurface, .browser, "\(step.name) lost the open surface")
            XCTAssertEqual(
                owner.composerDraft,
                "Keep this unfinished thought",
                "\(step.name) lost the composer draft")
            XCTAssertEqual(
                owner.transcriptPosition.viewID as? String,
                "message-42",
                "\(step.name) lost the transcript position")
        }
    }

    private func render(
        _ window: UIWindow,
        host: UIHostingController<AnyView>,
        step: LayoutStep
    ) {
        window.frame = CGRect(x: 0, y: 0, width: step.width, height: 768)
        host.view.frame = window.bounds
        window.setNeedsLayout()
        window.layoutIfNeeded()
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
    }
}

private struct LayoutStep {
    let name: String
    let sizeClass: UserInterfaceSizeClass
    let width: CGFloat
    let mode: ShellLayoutMode
}
