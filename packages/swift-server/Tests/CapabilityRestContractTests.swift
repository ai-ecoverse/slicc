import AsyncHTTPClient
import Foundation
import Hummingbird
import HummingbirdTesting
import XCTest

@testable import slicc_server














final class CapabilityRestContractTests: XCTestCase {
    override func setUp() {
        super.setUp()
        
        InMemoryKeychain.install()
    }

    override func tearDown() {
        InMemoryKeychain.uninstall()
        super.tearDown()
    }

    

    private struct Expectation {
        let status: Int
        let bodyKind: String?
        let itemFields: [String]
        let bodyFields: [String: LickSystem.JSONValue]
    }

    private struct Operation {
        let operation: String
        let method: String
        let path: String
        let servers: [String]?
    }

    private struct ServerCase {
        let name: String
        let method: String
        let path: String
        let body: Data?
        let servers: [String]?
        let expectation: Expectation
    }

    
    
    private static var fixtureURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  
            .deletingLastPathComponent()  
            .deletingLastPathComponent()  
            .appendingPathComponent("shared-ts/fixtures/capability-rest-contract.json")
    }

    private static func loadContract() throws -> [String: Any] {
        let data = try Data(contentsOf: fixtureURL)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "contract", code: 1, userInfo: [NSLocalizedDescriptionKey: "fixture is not an object"])
        }
        return object
    }

    private static func appliesToSwift(_ servers: [String]?) -> Bool {
        guard let servers else { return true }
        return servers.contains("swift")
    }

    

    
    
    
    private func makeRouter(httpClient: HTTPClient) -> Router<BasicRequestContext> {
        let router = Router()
        registerAPIRoutes(
            router: router,
            lickSystem: LickSystem(),
            config: makeConfig(),
            httpClient: httpClient,
            secretInjector: SecretInjector(secrets: [
                SecretInjector.LoadedSecret(
                    name: "CONTRACT_TOKEN",
                    realValue: "real-value-123",
                    maskedValue: "masked-value-123",
                    domains: ["api.example.com"]
                )
            ])
        )
        return router
    }

    

    func testEveryContractOperationHasARoute() async throws {
        let contract = try Self.loadContract()
        let operations = (contract["operations"] as? [[String: Any]]) ?? []
        XCTAssertFalse(operations.isEmpty, "contract fixture has no operations")

        try await withHTTPClient { httpClient in
            let app = Application(responder: self.makeRouter(httpClient: httpClient).buildResponder())
            try await app.test(.router) { client in
                for raw in operations {
                    guard let path = raw["path"] as? String, let method = raw["method"] as? String else {
                        XCTFail("operation entry is missing method/path")
                        continue
                    }
                    guard Self.appliesToSwift(raw["servers"] as? [String]) else { continue }
                    
                    
                    if path.contains("{") { continue }
                    let verb: HTTPRequest.Method = method == "*" ? .get : Self.verb(method)
                    let body: ByteBuffer? = verb == .post ? ByteBuffer(string: "{}") : nil
                    try await client.execute(
                        uri: path,
                        method: verb,
                        headers: [.contentType: "application/json"],
                        body: body
                    ) { response in
                        XCTAssertNotEqual(
                            response.status, .notFound,
                            "contract route \(method) \(path) is not registered on swift-server"
                        )
                    }
                }
            }
        }
    }

    func testServerCasesMatchTheContract() async throws {
        let contract = try Self.loadContract()
        let cases = (contract["serverCases"] as? [[String: Any]]) ?? []
        XCTAssertFalse(cases.isEmpty, "contract fixture has no server cases")

        try await withHTTPClient { httpClient in
            let app = Application(responder: self.makeRouter(httpClient: httpClient).buildResponder())
            try await app.test(.router) { client in
                for raw in cases {
                    guard
                        let name = raw["name"] as? String,
                        let method = raw["method"] as? String,
                        let path = raw["path"] as? String,
                        let expected = raw["expect"] as? [String: Any],
                        let expectedStatus = expected["status"] as? Int
                    else {
                        XCTFail("server case entry is malformed")
                        continue
                    }
                    guard Self.appliesToSwift(raw["servers"] as? [String]) else { continue }

                    var body: ByteBuffer?
                    if let payload = raw["body"] {
                        body = ByteBuffer(
                            data: try JSONSerialization.data(withJSONObject: payload, options: []))
                    }
                    let uri = path.replacingOccurrences(
                        of: "{{unknownSecret}}",
                        with: "NO_SUCH_SECRET_\(UUID().uuidString.prefix(8))"
                    )

                    try await client.execute(
                        uri: uri,
                        method: Self.verb(method),
                        headers: [.contentType: "application/json"],
                        body: body
                    ) { response in
                        XCTAssertEqual(
                            Int(response.status.code), expectedStatus,
                            "\(name): unexpected status for \(method) \(uri)"
                        )
                        try self.assertBody(response.body, matches: expected, caseName: name)
                    }
                }
            }
        }
    }

    

    private func assertBody(
        _ buffer: ByteBuffer,
        matches expected: [String: Any],
        caseName: String
    ) throws {
        let data = Data(buffer.readableBytesView)
        let decoded = try JSONSerialization.jsonObject(with: data)

        if let kind = expected["bodyKind"] as? String {
            if kind == "array" {
                guard let items = decoded as? [Any] else {
                    return XCTFail("\(caseName): body is not an array")
                }
                for field in (expected["itemFields"] as? [String]) ?? [] {
                    for item in items {
                        guard let object = item as? [String: Any] else {
                            return XCTFail("\(caseName): array item is not an object")
                        }
                        XCTAssertNotNil(object[field], "\(caseName): item is missing \(field)")
                    }
                }
            } else {
                XCTAssertTrue(
                    decoded is [String: Any], "\(caseName): body is not a JSON object")
            }
        }

        guard let fields = expected["bodyFields"] as? [String: Any], !fields.isEmpty else { return }
        guard let object = decoded as? [String: Any] else {
            return XCTFail("\(caseName): bodyFields expected an object body")
        }
        for (field, value) in fields {
            if let boolValue = value as? Bool, let actual = object[field] as? Bool {
                XCTAssertEqual(actual, boolValue, "\(caseName): \(field) mismatch")
            } else if let stringValue = value as? String, let actual = object[field] as? String {
                XCTAssertEqual(actual, stringValue, "\(caseName): \(field) mismatch")
            } else {
                XCTFail("\(caseName): \(field) missing or of an unexpected type")
            }
        }
    }

    

    private static func verb(_ method: String) -> HTTPRequest.Method {
        switch method.uppercased() {
        case "GET": return .get
        case "POST": return .post
        case "PUT": return .put
        case "DELETE": return .delete
        case "PATCH": return .patch
        default: return .get
        }
    }

    private func makeConfig() -> ServerConfig {
        .init(
            serveOnly: false,
            cdpPort: 9222,
            explicitCdpPort: false,
            electron: false,
            electronApp: nil,
            electronAppURL: nil,
            kill: false,
            lead: false,
            leadWorkerBaseUrl: nil,
            leadWorkerBaseURL: nil,
            profile: nil,
            join: false,
            joinUrl: nil,
            joinURL: nil,
            logLevel: "info",
            logDir: nil,
            logDirectoryURL: nil,
            prompt: nil,
            envFile: nil,
            envFileURL: nil
        )
    }

    private func withHTTPClient(
        _ body: (HTTPClient) async throws -> Void
    ) async throws {
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        do {
            try await body(httpClient)
            try await httpClient.shutdown()
        } catch {
            try? await httpClient.shutdown()
            throw error
        }
    }
}
