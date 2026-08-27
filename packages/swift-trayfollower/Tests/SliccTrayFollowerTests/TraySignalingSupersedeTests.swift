import Foundation
import XCTest

@testable import SliccTrayFollower

/// What `attach` makes of a superseded tray's reply (#1957), over the
/// `Transport` seam — no live hub.
final class TraySignalingSupersedeTests: XCTestCase {

    private let joinUrl = URL(string: "https://www.sliccy.ai/join/old.secret")!
    private let successorLink =
        #"<https://www.sliccy.ai/join/fresh.beef>; rel="successor-version""#

    private func client(
        status: Int, body: String, headers: [String: String] = [:]
    ) -> TraySignalingClient {
        TraySignalingClient(joinUrl: joinUrl) { [joinUrl] _ in
            let response = HTTPURLResponse(
                url: joinUrl, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: headers)!
            return (Data(body.utf8), response)
        }
    }

    private func supersededBody(code: String, joinUrl: String?) -> String {
        let replacement = joinUrl.map { #", "joinUrl": "\#($0)""# } ?? ""
        return #"""
            {"trayId":"t1","controllerId":"c1","role":"follower","leader":null,
             "participantCount":1,
             "result":{"action":"fail","code":"\#(code)","error":"moved"\#(replacement)}}
            """#
    }

    /// The shipped contract: body only, no link. Unchanged.
    func testFollowsTheBodyJoinUrlWhenThereIsNoLink() async throws {
        let plan = try await client(
            status: 409,
            body: supersededBody(
                code: "TRAY_SUPERSEDED", joinUrl: "https://www.sliccy.ai/join/from-body.beef")
        ).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/from-body.beef")
    }

    /// The link is the channel that survives a body-shape change, so it wins.
    func testPrefersTheLinkOverTheBodyJoinUrl() async throws {
        let plan = try await client(
            status: 409,
            body: supersededBody(
                code: "TRAY_SUPERSEDED", joinUrl: "https://www.sliccy.ai/join/from-body.beef"),
            headers: ["Link": successorLink]
        ).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/fresh.beef")
    }

    /// A body this build cannot validate is not a dead end when the hub said
    /// where the tray went — the #1956 failure mode, closed.
    func testFollowsTheLinkWhenTheBodyDoesNotValidate() async throws {
        let plan = try await client(
            status: 409,
            body: #"{"trayId":"t1","controllerId":"c1","role":"follower","leader":null,"#
                + #""participantCount":1,"result":{"action":"redirect","code":"MOVED"}}"#,
            headers: ["Link": successorLink]
        ).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/fresh.beef")
        XCTAssertEqual(plan.code, "TRAY_SUPERSEDED")
    }

    /// …and one that is not even JSON.
    func testFollowsTheLinkWhenTheBodyIsNotDecodable() async throws {
        let plan = try await client(
            status: 409, body: "<html>gateway error</html>",
            headers: ["Link": successorLink]
        ).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/fresh.beef")
    }

    /// Without a link, an unrecognized body is still an error — the link is
    /// the only thing that redeems it.
    func testStillThrowsOnAnUnreadableBodyWithNoLink() async {
        do {
            _ = try await client(status: 409, body: "<html>gateway error</html>")
                .attach(controllerId: "c1")
            XCTFail("expected an invalid-response error")
        } catch let error as TraySignalingError {
            guard case .invalidAttachResponse = error else {
                return XCTFail("unexpected error: \(error)")
            }
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    /// A supersede that names no replacement anywhere stays terminal.
    func testSupersededWithoutAnyReplacementIsStillInvalid() async {
        do {
            _ = try await client(
                status: 409, body: supersededBody(code: "TRAY_SUPERSEDED", joinUrl: nil)
            ).attach(controllerId: "c1")
            XCTFail("expected an invalid-response error")
        } catch let error as TraySignalingError {
            guard case .invalidAttachResponse = error else {
                return XCTFail("unexpected error: \(error)")
            }
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}
