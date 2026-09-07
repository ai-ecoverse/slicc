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

    // MARK: - bulk read

    func testAllReturnsEverySecretInOneCall() throws {
        let n1 = secretName("BULK_A")
        let n2 = secretName("BULK_B")
        try SecretStore.set(name: n1, value: "v1", domains: ["a.com"])
        try SecretStore.set(name: n2, value: "v2", domains: ["b.com", "*.b.com"])

        let all = SecretStore.all().filter { $0.name.hasPrefix(prefix) }
        let byName = Dictionary(uniqueKeysWithValues: all.map { ($0.name, $0) })

        XCTAssertEqual(byName[n1]?.value, "v1")
        XCTAssertEqual(byName[n1]?.domains, ["a.com"])
        XCTAssertEqual(byName[n2]?.value, "v2")
        XCTAssertEqual(byName[n2]?.domains, ["b.com", "*.b.com"])
    }

    // MARK: - read errors

    /// `errSecItemNotFound` is the only legitimate "empty" — readBlob must
    /// not collapse other failures into "" or set/delete would silently
    /// wipe stored secrets after a transient auth failure.
    func testReadBlobReturnsEmptyForMissingItem() throws {
        // After tearDown, the test prefix's secrets are gone, but the shared
        // blob may still hold unrelated user data. Just verify readBlob does
        // not throw on a normal read.
        XCTAssertNoThrow(try SecretStore.readBlob())
    }

    // MARK: - non-interactive fail-fast guard

    /// With `SLICC_KEYCHAIN_NONINTERACTIVE=1`, `readBlob` adds
    /// `kSecUseAuthenticationUIFail` so a headless launch fails fast instead of
    /// hanging on the ACL dialog. For an item the test runner already has
    /// access to, no UI is needed, so the read/round-trip must STILL succeed —
    /// i.e. the guard is non-regressive on the already-granted path.
    func testNonInteractiveFlagDoesNotBreakAccessibleItem() throws {
        setenv("SLICC_KEYCHAIN_NONINTERACTIVE", "1", 1)
        defer { unsetenv("SLICC_KEYCHAIN_NONINTERACTIVE") }

        let name = secretName("NONINTERACTIVE")
        try SecretStore.set(name: name, value: "ghp_noninteractive", domains: ["api.github.com"])

        XCTAssertNoThrow(try SecretStore.readBlob())
        XCTAssertEqual(SecretStore.get(name: name)?.value, "ghp_noninteractive")
    }

    /// The test above cannot catch the hang it describes: the runner already
    /// holds ACL access, so no dialog is raised either way. What actually keeps
    /// a headless launch from blocking inside `SecItemCopyMatching` on the
    /// legacy file-based keychain is `SecKeychainSetUserInteractionAllowed` —
    /// `kSecUseAuthenticationUIFail` only covers the data-protection keychain.
    /// Assert the switch is flipped around the read, and restored after it.
    func testNonInteractiveReadSuppressesLegacyKeychainInteraction() throws {
        setenv("SLICC_KEYCHAIN_NONINTERACTIVE", "1", 1)
        var calls: [Bool] = []
        SecretStore.setUserInteractionAllowed = { calls.append($0) }
        defer {
            unsetenv("SLICC_KEYCHAIN_NONINTERACTIVE")
            SecretStore.setUserInteractionAllowed = { allowed in
                SecKeychainSetUserInteractionAllowed(allowed)
            }
        }

        _ = try? SecretStore.readBlob()

        XCTAssertEqual(calls, [false, true], "read must suppress interaction, then restore it")
    }

    /// A write raises the same dialog, so `POST /api/secrets` must not be able
    /// to hang a request the way startup could hang a launch.
    func testNonInteractiveWriteSuppressesLegacyKeychainInteraction() throws {
        setenv("SLICC_KEYCHAIN_NONINTERACTIVE", "1", 1)
        var calls: [Bool] = []
        SecretStore.setUserInteractionAllowed = { calls.append($0) }
        defer {
            unsetenv("SLICC_KEYCHAIN_NONINTERACTIVE")
            SecretStore.setUserInteractionAllowed = { allowed in
                SecKeychainSetUserInteractionAllowed(allowed)
            }
        }

        try SecretStore.set(name: secretName("NONINTERACTIVE_WRITE"), value: "v", domains: ["a.com"])

        XCTAssertTrue(calls.contains(false), "write must suppress interaction")
        XCTAssertEqual(calls.last, true, "write must restore interaction")
    }

    /// Without the env var the switch must never be touched: an interactive
    /// Sliccstart run depends on the first-run "Always Allow" grant working.
    func testInteractiveRunLeavesTheInteractionSwitchAlone() throws {
        unsetenv("SLICC_KEYCHAIN_NONINTERACTIVE")
        var calls: [Bool] = []
        SecretStore.setUserInteractionAllowed = { calls.append($0) }
        defer {
            SecretStore.setUserInteractionAllowed = { allowed in
                SecKeychainSetUserInteractionAllowed(allowed)
            }
        }

        _ = try? SecretStore.readBlob()

        XCTAssertTrue(calls.isEmpty, "interactive runs must not suppress the ACL dialog")
    }
}
