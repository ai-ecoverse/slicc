import XCTest

@testable import slicc_server

final class SessionSecretStoreTests: XCTestCase {
    func testSetReplaceListScopeAndDelete() async {
        let store = SessionSecretStore()

        await store.set(name: "TOKEN", value: "first-fixture-value", domains: ["one.example"])
        await store.set(name: "TOKEN", value: "replacement-fixture-value", domains: ["two.example"])

        let record = await store.getRecord(name: "TOKEN")
        let list = await store.list()
        XCTAssertEqual(record, .init(name: "TOKEN", value: "replacement-fixture-value", domains: ["two.example"]))
        XCTAssertEqual(list, [SecretEntry(name: "TOKEN", domains: ["two.example"])])
        let updated = await store.setDomains(name: "TOKEN", domains: ["three.example"])
        let updatedRecord = await store.getRecord(name: "TOKEN")
        XCTAssertTrue(updated)
        XCTAssertEqual(updatedRecord?.domains, ["three.example"])
        let deleted = await store.delete(name: "TOKEN")
        let deletedRecord = await store.getRecord(name: "TOKEN")
        XCTAssertTrue(deleted)
        XCTAssertNil(deletedRecord)
    }

    func testIndependentStoreStartsEmpty() async {
        let original = SessionSecretStore()
        await original.set(name: "TOKEN", value: "process-only-fixture", domains: [])

        let restarted = SessionSecretStore()

        let restartedEntries = await restarted.listAll()
        XCTAssertTrue(restartedEntries.isEmpty)
    }

    func testPreviewAlwaysElidesTheCompleteValue() {
        XCTAssertEqual(previewSecret(""), "")
        XCTAssertEqual(previewSecret("ab"), "…")
        XCTAssertEqual(previewSecret("fixture-value"), "fixt…alue")
        XCTAssertNotEqual(previewSecret("fixture-value"), "fixture-value")
    }
}
