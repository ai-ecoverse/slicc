import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

final class SliccIconsTests: XCTestCase {

    func testScoopToolsUseThePortedConeNotATeacup() {
        XCTAssertEqual(SliccIcons.tool("scoop_scoop"), .lucide(.iceCreamCone))
        XCTAssertEqual(SliccIcons.tool("list_scoops"), .lucide(.iceCreamCone))
    }

    func testScoopMuteUsesBellNotSpeaker() {
        XCTAssertEqual(SliccIcons.tool("scoop_mute"), .system("bell.slash"))
        XCTAssertEqual(
            SliccIcons.tool("scoop_unmute"),
            .system("bell.and.waves.left.and.right"))
    }

    func testLickChannelsMatchWebMetaphors() {
        XCTAssertEqual(SliccIcons.lick("fswatch"), .system("eye"))
        XCTAssertEqual(SliccIcons.lick("scoop-idle"), .system("moon"))
        XCTAssertEqual(SliccIcons.lick("scoop-wait"), .system("hourglass"))
        XCTAssertEqual(
            SliccIcons.lick("scoop-notify"),
            .system("bell.and.waves.left.and.right"))
    }

    func testAcceptedStandInsStayPut() {

        XCTAssertEqual(SliccIcons.tool("bash"), .system("terminal"))
        XCTAssertEqual(SliccIcons.tool("send_message"), .system("message.fill"))
        XCTAssertEqual(SliccIcons.tool("feed_scoop"), .system("fork.knife"))
    }

    func testMessageSourceUsesIceCreamIdentity() {
        let cone = ChatMessage(
            id: "1", role: .assistant, content: "hi", timestamp: 0, source: "cone")
        let scoop = ChatMessage(
            id: "2", role: .assistant, content: "hi", timestamp: 0, source: "researcher")
        XCTAssertEqual(SliccIcons.messageSource(cone), .lucide(.iceCreamCone))
        XCTAssertEqual(SliccIcons.messageSource(scoop), .lucide(.iceCreamBowl))
    }
}
