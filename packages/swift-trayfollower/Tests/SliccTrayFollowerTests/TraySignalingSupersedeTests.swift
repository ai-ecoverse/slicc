import Foundation
import XCTest

@testable import SliccTrayFollower

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

    func testFollowsTheBodyJoinUrlWhenThereIsNoLink() async throws {
        let plan = try await client(
            status: 409,
            body: supersededBody(
                code: "TRAY_SUPERSEDED", joinUrl: "https://www.sliccy.ai/join/from-body.beef")
        ).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/from-body.beef")
    }

    func testAcceptsThe308RedirectBody() async throws {
        let body = #"""
            {"trayId":"t1","controllerId":"c1","role":"follower","leader":null,
             "participantCount":1,
             "result":{"action":"redirect","code":"TRAY_SUPERSEDED","error":"moved",
                       "joinUrl":"https://www.sliccy.ai/join/fresh.beef"}}
            """#
        let plan = try await client(
            status: 308, body: body,
            headers: ["Location": "https://www.sliccy.ai/join/fresh.beef?json=true"]
        ).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/fresh.beef")

        XCTAssertEqual(plan.action, .fail)
    }

    func testFollowsThe308LocationAlone() async throws {
        let plan = try await client(
            status: 308, body: "",
            headers: ["Location": "https://www.sliccy.ai/join/fresh.beef?json=true"]
        ).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/fresh.beef")
    }

    func testRejectsARedirectBodyWithoutAJoinUrl() async {
        let body = #"""
            {"trayId":"t1","controllerId":"c1","role":"follower","leader":null,
             "participantCount":1,
             "result":{"action":"redirect","code":"TRAY_SUPERSEDED","error":"moved"}}
            """#
        do {
            _ = try await client(status: 308, body: body).attach(controllerId: "c1")
            XCTFail("expected an invalid-attach-response error")
        } catch {

        }
    }

    func testPrefersTheLinkOverTheBodyJoinUrl() async throws {
        let plan = try await client(
            status: 409,
            body: supersededBody(
                code: "TRAY_SUPERSEDED", joinUrl: "https://www.sliccy.ai/join/from-body.beef"),
            headers: ["Link": successorLink]
        ).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/fresh.beef")
    }

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

    func testFollowsTheLinkWhenTheBodyIsNotDecodable() async throws {
        let plan = try await client(
            status: 409, body: "<html>gateway error</html>",
            headers: ["Link": successorLink]
        ).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/fresh.beef")
    }

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
