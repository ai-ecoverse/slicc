import XCTest
@testable import Sliccstart

final class UpdateHostConfigurationTests: XCTestCase {
    func testDefaultsToProductionGithubAPI() {
        let host = UpdateHostConfiguration.resolve(arguments: ["Sliccstart"], environment: [:])
        XCTAssertEqual(host.baseURL, UpdateHostConfiguration.productionBaseURL)
    }

    func testArgumentEqualsFormWins() {
        let host = UpdateHostConfiguration.resolve(
            arguments: ["Sliccstart", "--update-host=http://localhost:9999"],
            environment: ["SLICC_UPDATE_HOST": "http://should-not-win:1"]
        )
        XCTAssertEqual(host.baseURL.absoluteString, "http://localhost:9999")
    }

    func testArgumentSpaceFormIsRecognized() {
        let host = UpdateHostConfiguration.resolve(
            arguments: ["Sliccstart", "--update-host", "http://localhost:8888"],
            environment: [:]
        )
        XCTAssertEqual(host.baseURL.absoluteString, "http://localhost:8888")
    }

    func testEnvironmentVariableUsedWhenArgumentMissing() {
        let host = UpdateHostConfiguration.resolve(
            arguments: ["Sliccstart"],
            environment: ["SLICC_UPDATE_HOST": "http://env-host:7777"]
        )
        XCTAssertEqual(host.baseURL.absoluteString, "http://env-host:7777")
    }

    func testEmptyEnvironmentValueIsIgnored() {
        let host = UpdateHostConfiguration.resolve(
            arguments: ["Sliccstart"],
            environment: ["SLICC_UPDATE_HOST": ""]
        )
        XCTAssertEqual(host.baseURL, UpdateHostConfiguration.productionBaseURL)
    }

    func testReleasesURLIsBuiltFromHost() {
        let host = UpdateHostConfiguration(baseURL: URL(string: "http://localhost:9999")!)
        XCTAssertEqual(
            host.releasesURL(owner: "ai-ecoverse", repo: "slicc").absoluteString,
            "http://localhost:9999/repos/ai-ecoverse/slicc/releases"
        )
    }
}
