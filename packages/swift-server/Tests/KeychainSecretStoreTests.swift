import XCTest
@testable import slicc_server

final class KeychainSecretStoreTests: XCTestCase {
    /// Unique prefix per test run so parallel/repeated runs don't collide.
    private let prefix = "TEST_\(UUID().uuidString.prefix(8))_"

    private func secretName(_ base: String) -> String { prefix + base }

    override func tearDown() {
        // Clean up any leftover test secrets.
        for entry in SecretStore.list() where entry.name.hasPrefix(prefix) {
            try? SecretStore.delete(name: entry.name)
        }
        super.tearDown()
    }

    // MARK: - set + get round-trip

    func testSetAndGetRoundTrip() throws {
        let name = secretName("GITHUB_TOKEN")
        try SecretStore.set(name: name, value: "ghp_abc123", domains: ["api.github.com", "*.github.com"])

        let secret = SecretStore.get(name: name)
        XCTAssertNotNil(secret)
        XCTAssertEqual(secret?.name, name)
        XCTAssertEqual(secret?.value, "ghp_abc123")
        XCTAssertEqual(secret?.domains, ["api.github.com", "*.github.com"])
    }

    // MARK: - update existing secret

    func testSetOverwritesExistingSecret() throws {
        let name = secretName("OPENAI_KEY")
        try SecretStore.set(name: name, value: "sk-old", domains: ["api.openai.com"])
        try SecretStore.set(name: name, value: "sk-new", domains: ["api.openai.com", "api.azure.com"])

        let secret = SecretStore.get(name: name)
        XCTAssertEqual(secret?.value, "sk-new")
        XCTAssertEqual(secret?.domains, ["api.openai.com", "api.azure.com"])
    }

    // MARK: - get non-existent

    func testGetReturnsNilForMissingSecret() {
        XCTAssertNil(SecretStore.get(name: secretName("DOES_NOT_EXIST")))
    }

    // MARK: - delete

    func testDeleteRemovesSecret() throws {
        let name = secretName("TO_DELETE")
        try SecretStore.set(name: name, value: "val", domains: ["example.com"])
        try SecretStore.delete(name: name)
        XCTAssertNil(SecretStore.get(name: name))
    }

    func testDeleteNonExistentDoesNotThrow() throws {
        try SecretStore.delete(name: secretName("NEVER_EXISTED"))
    }

    // MARK: - list

    func testListReturnsNamesAndDomainsWithoutValues() throws {
        let name1 = secretName("LIST_A")
        let name2 = secretName("LIST_B")
        try SecretStore.set(name: name1, value: "secret1", domains: ["a.com"])
        try SecretStore.set(name: name2, value: "secret2", domains: ["b.com", "c.com"])

        let entries = SecretStore.list().filter { $0.name.hasPrefix(prefix) }
        let names = entries.map(\.name).sorted()

        XCTAssertEqual(names, [name1, name2].sorted())
        // Ensure values are not included (SecretEntry has no value field by design).
        for entry in entries {
            if entry.name == name1 {
                XCTAssertEqual(entry.domains, ["a.com"])
            } else if entry.name == name2 {
                XCTAssertEqual(entry.domains, ["b.com", "c.com"])
            }
        }
    }

    // MARK: - empty domains rejected

    func testSetRejectsEmptyDomains() {
        let name = secretName("NO_DOMAINS")
        XCTAssertThrowsError(try SecretStore.set(name: name, value: "val", domains: [])) { error in
            XCTAssertEqual(error as? SecretStoreError, .emptyDomains)
        }
        XCTAssertNil(SecretStore.get(name: name))
    }
}

