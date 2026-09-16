import XCTest

@testable import SwiftOptel

final class CrossImplementationTests: XCTestCase {
    private struct Vector {
        let name: String
        let event: RUMEvent
        let collectBaseURL: URL
        let expectedURL: String

        let expectedBody: String
    }

    private static let defaultBase = URL(string: "https://rum.hlx.page/")!

    private static let vectors: [Vector] = [

        Vector(
            name: "top-default-weight",
            event: RUMEvent(
                weight: 100,
                id: "abc123def",
                referer: "https://com.example.app/",
                checkpoint: .top,
                t: 0
            ),
            collectBaseURL: defaultBase,
            expectedURL: "https://rum.hlx.page/.rum/100",
            expectedBody: """
                {"weight":100,"id":"abc123def","referer":"https://com.example.app/",\
                "checkpoint":"top","t":0}
                """
        ),

        Vector(
            name: "click-full-pingdata",
            event: RUMEvent(
                weight: 100,
                id: "abc123def",
                referer: "https://com.example.app/home",
                checkpoint: .click,
                t: 1234,
                pingData: RUMPingData(
                    source: ".button#submit",
                    target: "/api/checkout",
                    value: 42
                )
            ),
            collectBaseURL: defaultBase,
            expectedURL: "https://rum.hlx.page/.rum/100",
            expectedBody: """
                {"weight":100,"id":"abc123def","referer":"https://com.example.app/home",\
                "checkpoint":"click","t":1234,"source":".button#submit",\
                "target":"/api/checkout","value":42}
                """
        ),

        Vector(
            name: "rate-on-weight-1",
            event: RUMEvent(
                weight: 1,
                id: "000000001",
                referer: "https://com.example.app/settings",
                checkpoint: .navigate,
                t: 500,
                pingData: RUMPingData(source: "SettingsView")
            ),
            collectBaseURL: defaultBase,
            expectedURL: "https://rum.hlx.page/.rum/1",
            expectedBody: """
                {"weight":1,"id":"000000001","referer":"https://com.example.app/settings",\
                "checkpoint":"navigate","t":500,"source":"SettingsView"}
                """
        ),

        Vector(
            name: "rate-high-weight-10",
            event: RUMEvent(
                weight: 10,
                id: "deadbeef0",
                referer: "https://com.example.app/",
                checkpoint: .enter,
                t: 0
            ),
            collectBaseURL: defaultBase,
            expectedURL: "https://rum.hlx.page/.rum/10",
            expectedBody: """
                {"weight":10,"id":"deadbeef0","referer":"https://com.example.app/",\
                "checkpoint":"enter","t":0}
                """
        ),

        Vector(
            name: "rate-low-weight-1000",
            event: RUMEvent(
                weight: 1000,
                id: "feedface1",
                referer: "https://com.example.app/error",
                checkpoint: .error,
                t: 9999,
                pingData: RUMPingData(
                    source: "NSCocoaErrorDomain",
                    target: "File not found"
                )
            ),
            collectBaseURL: defaultBase,
            expectedURL: "https://rum.hlx.page/.rum/1000",
            expectedBody: """
                {"weight":1000,"id":"feedface1","referer":"https://com.example.app/error",\
                "checkpoint":"error","t":9999,"source":"NSCocoaErrorDomain",\
                "target":"File not found"}
                """
        ),

        Vector(
            name: "custom-collector-base",
            event: RUMEvent(
                weight: 100,
                id: "cafebabe0",
                referer: "https://com.example.app/",
                checkpoint: .top,
                t: 0
            ),
            collectBaseURL: URL(string: "https://custom.example.com/path/")!,
            expectedURL: "https://custom.example.com/path/.rum/100",
            expectedBody: """
                {"weight":100,"id":"cafebabe0","referer":"https://com.example.app/",\
                "checkpoint":"top","t":0}
                """
        ),
    ]

    func testCollectorURLMatchesHelixRumJsForAllVectors() throws {
        for v in Self.vectors {
            let request = try XCTUnwrap(
                URLSessionOptelTransport.makeRequest(
                    event: v.event,
                    collectBaseURL: v.collectBaseURL,
                    timeout: 10
                ),
                "makeRequest returned nil for vector \(v.name)"
            )
            XCTAssertEqual(
                request.url?.absoluteString,
                v.expectedURL,
                "URL mismatch for vector \(v.name)"
            )
        }
    }

    func testHTTPMethodAndContentTypeMatchHelixRumJsBeacon() throws {
        for v in Self.vectors {
            let request = try XCTUnwrap(
                URLSessionOptelTransport.makeRequest(
                    event: v.event,
                    collectBaseURL: v.collectBaseURL,
                    timeout: 10
                ),
                "makeRequest returned nil for vector \(v.name)"
            )
            XCTAssertEqual(request.httpMethod, "POST", "method mismatch for \(v.name)")
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Content-Type"),
                "application/json",
                "Content-Type mismatch for \(v.name)"
            )
        }
    }

    func testEncodedBodyMatchesHelixRumJsFixtureForAllVectors() throws {
        for v in Self.vectors {
            let actualData = try JSONEncoder().encode(v.event)
            let actualObject = try XCTUnwrap(
                JSONSerialization.jsonObject(with: actualData) as? NSDictionary,
                "could not parse encoded body for \(v.name)"
            )
            let expectedObject = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(v.expectedBody.utf8)) as? NSDictionary,
                "could not parse expected fixture for \(v.name)"
            )
            XCTAssertEqual(
                actualObject,
                expectedObject,
                "body mismatch for vector \(v.name)"
            )
        }
    }

    func testRequestBodyParsesToSameObjectAsExpectedFixture() throws {

        for v in Self.vectors {
            let request = try XCTUnwrap(
                URLSessionOptelTransport.makeRequest(
                    event: v.event,
                    collectBaseURL: v.collectBaseURL,
                    timeout: 10
                ),
                "makeRequest returned nil for vector \(v.name)"
            )
            let body = try XCTUnwrap(request.httpBody, "missing body for \(v.name)")
            let actualObject = try XCTUnwrap(
                JSONSerialization.jsonObject(with: body) as? NSDictionary,
                "could not parse request body for \(v.name)"
            )
            let expectedObject = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(v.expectedBody.utf8)) as? NSDictionary,
                "could not parse expected fixture for \(v.name)"
            )
            XCTAssertEqual(
                actualObject,
                expectedObject,
                "wire-format body mismatch for vector \(v.name)"
            )
        }
    }
}
