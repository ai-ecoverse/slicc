import XCTest
@testable import slicc_server

final class OAuthSecretStoreTests: XCTestCase {

    func testSetThenListReturnsTheEntry() async throws {
        let store = OAuthSecretStore()
        try await store.set(name: "oauth.github.token", value: "ghp_real", domains: ["github.com"])
        let entries = await store.list()
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(
            entries.first,
            .init(name: "oauth.github.token", value: "ghp_real", domains: ["github.com"])
        )
    }

    func testDeleteRemovesTheEntry() async throws {
        let store = OAuthSecretStore()
        try await store.set(name: "A", value: "1", domains: ["x.com"])
        await store.delete(name: "A")
        let entries = await store.list()
        XCTAssertTrue(entries.isEmpty)
    }

    func testRejectsEmptyDomainsArray() async {
        let store = OAuthSecretStore()
        do {
            try await store.set(name: "A", value: "1", domains: [])
            XCTFail("Expected emptyDomains error")
        } catch let error as OAuthSecretStore.OAuthSecretStoreError {
            XCTAssertEqual(error, .emptyDomains)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testGetReturnsValueOrNil() async throws {
        let store = OAuthSecretStore()
        try await store.set(name: "A", value: "1", domains: ["x.com"])
        let present = await store.get(name: "A")
        XCTAssertEqual(present, "1")
        let absent = await store.get(name: "B")
        XCTAssertNil(absent)
    }

    /// Concurrency smoke test: two tasks set different names concurrently.
    /// The actor's serialization guarantees both writes land without a data
    /// race; both names must be visible afterwards.
    func testConcurrentSetsBothSucceed() async throws {
        let store = OAuthSecretStore()
        async let a: Void = store.set(name: "A", value: "1", domains: ["a.com"])
        async let b: Void = store.set(name: "B", value: "2", domains: ["b.com"])
        _ = try await (a, b)
        let entries = await store.list().sorted { $0.name < $1.name }
        XCTAssertEqual(entries.map(\.name), ["A", "B"])
        XCTAssertEqual(entries.map(\.value), ["1", "2"])
    }
}
