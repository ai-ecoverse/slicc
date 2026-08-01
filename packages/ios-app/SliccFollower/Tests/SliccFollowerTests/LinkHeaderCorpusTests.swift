import XCTest

@testable import SliccFollower

/// Holds the Swift `Link` parser to the same golden corpus the TS parser is
/// validated against (`packages/webapp/tests/net/link-header-corpus.test.ts`).
///
/// Two implementations of one attacker-controlled parser is the risk this
/// suite exists to manage. The failure that matters is asymmetric: this side
/// recognising a handoff the web side would not, or accepting a `branch` the
/// web side drops, because the value ends up as an argv token in an `upskill`
/// call behind an approval card.
final class LinkHeaderCorpusTests: XCTestCase {
    private struct CorpusError: Error, CustomStringConvertible {
        let description: String
    }

    private struct ExpectedLink {
        let href: String
        let rel: [String]
        let params: [String: String]
    }

    private struct ExpectedHandoff {
        let verb: String
        let target: String
        let instruction: String?
        let branch: String?
        let path: String?
    }

    private struct Case {
        let name: String
        let header: [String]
        let baseURL: String?
        let links: [ExpectedLink]
        let handoff: ExpectedHandoff?
    }

    private func loadCases() throws -> [Case] {
        // Fail hard rather than skip: a fixture lost to project.yml drift must
        // not turn this suite quietly green.
        guard
            let url = Bundle(for: Self.self).url(
                forResource: "link-header-corpus", withExtension: "json")
        else {
            throw CorpusError(
                description:
                    "link-header-corpus.json missing from test bundle — check the project.yml Fixtures copy"
            )
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let declaredCount = root["caseCount"] as? Int,
            let rawCases = root["cases"] as? [[String: Any]]
        else {
            throw CorpusError(description: "link-header-corpus.json is malformed")
        }
        guard rawCases.count == declaredCount else {
            throw CorpusError(
                description: "corpus declares \(declaredCount) cases but carries \(rawCases.count)")
        }
        // The rels are in the fixture so a rename on the TS side lands here
        // rather than silently disabling every handoff on the phone.
        XCTAssertEqual(root["handoffRel"] as? String, HandoffLink.handoffRel)
        XCTAssertEqual(root["upskillRel"] as? String, HandoffLink.upskillRel)

        return try rawCases.map { raw in
            guard let name = raw["name"] as? String else {
                throw CorpusError(description: "case without a name")
            }
            let header: [String]
            if let single = raw["header"] as? String {
                header = [single]
            } else if let many = raw["header"] as? [String] {
                header = many
            } else {
                throw CorpusError(description: "case '\(name)' has no header")
            }
            let links = (raw["links"] as? [[String: Any]] ?? []).map { link in
                ExpectedLink(
                    href: link["href"] as? String ?? "",
                    rel: link["rel"] as? [String] ?? [],
                    params: link["params"] as? [String: String] ?? [:])
            }
            var handoff: ExpectedHandoff?
            if let raw = raw["handoff"] as? [String: Any] {
                handoff = ExpectedHandoff(
                    verb: raw["verb"] as? String ?? "",
                    target: raw["target"] as? String ?? "",
                    instruction: raw["instruction"] as? String,
                    branch: raw["branch"] as? String,
                    path: raw["path"] as? String)
            }
            return Case(
                name: name, header: header, baseURL: raw["baseUrl"] as? String, links: links,
                handoff: handoff)
        }
    }

    func testCorpusIsNotEmpty() throws {
        // Guards the guard: an empty or truncated fixture would make every
        // assertion below vacuous.
        let cases = try loadCases()
        XCTAssertGreaterThanOrEqual(cases.count, 30, "corpus shrank — did a regeneration truncate it?")
    }

    func testParsedLinksMatchTheCorpus() throws {
        for testCase in try loadCases() {
            let parsed = LinkHeader.parse(testCase.header, baseURL: testCase.baseURL)
            XCTAssertEqual(
                parsed.count, testCase.links.count,
                "link count for '\(testCase.name)'")
            for (index, expected) in testCase.links.enumerated() where index < parsed.count {
                let actual = parsed[index]
                XCTAssertEqual(actual.href, expected.href, "href[\(index)] for '\(testCase.name)'")
                XCTAssertEqual(actual.rel, expected.rel, "rel[\(index)] for '\(testCase.name)'")
                XCTAssertEqual(
                    actual.params, expected.params, "params[\(index)] for '\(testCase.name)'")
            }
        }
    }

    func testExtractedHandoffsMatchTheCorpus() throws {
        for testCase in try loadCases() {
            let parsed = LinkHeader.parse(testCase.header, baseURL: testCase.baseURL)
            let match = HandoffLink.extract(from: parsed)
            guard let expected = testCase.handoff else {
                XCTAssertNil(match, "expected no handoff for '\(testCase.name)'")
                continue
            }
            guard let match else {
                XCTFail("expected a \(expected.verb) handoff for '\(testCase.name)', got none")
                continue
            }
            XCTAssertEqual(match.verb.rawValue, expected.verb, "verb for '\(testCase.name)'")
            XCTAssertEqual(match.target, expected.target, "target for '\(testCase.name)'")
            XCTAssertEqual(
                match.instruction, expected.instruction, "instruction for '\(testCase.name)'")
            XCTAssertEqual(match.branch, expected.branch, "branch for '\(testCase.name)'")
            XCTAssertEqual(match.path, expected.path, "path for '\(testCase.name)'")
        }
    }

    // MARK: - Allowlist units
    //
    // The corpus covers these end-to-end, but the predicates are the security
    // boundary, so they get direct coverage of the boundary values too.

    func testBranchAllowlistRejectsShellMetacharacters() {
        for unsafe in ["a;b", "a|b", "a&b", "a$b", "a`b", "a(b", "a b", "a\nb", "a\"b", "a'b"] {
            XCTAssertFalse(HandoffLink.isSafeBranch(unsafe), "should reject \(unsafe.debugDescription)")
        }
    }

    func testBranchAllowlistRejectsGitRefViolations() {
        for unsafe in ["", "-lead", "/lead", "trail/", "a..b", "main.lock", String(repeating: "a", count: 251)] {
            XCTAssertFalse(HandoffLink.isSafeBranch(unsafe), "should reject \(unsafe.debugDescription)")
        }
    }

    func testBranchAllowlistAcceptsOrdinaryRefs() {
        for safe in ["main", "feature/new-thing", "release-1.2.3", "a_b", String(repeating: "a", count: 250)] {
            XCTAssertTrue(HandoffLink.isSafeBranch(safe), "should accept \(safe.debugDescription)")
        }
    }

    func testPathAllowlistRejectsTraversalAndAbsolutes() {
        for unsafe in ["", "/etc/passwd", "../x", "a/../b", "-flag", "a b", String(repeating: "a", count: 1025)] {
            XCTAssertFalse(HandoffLink.isSafePath(unsafe), "should reject \(unsafe.debugDescription)")
        }
    }

    func testPathAllowlistAcceptsRepoRelativeDirectories() {
        for safe in ["skills/demo", "a", "a/b/c", "a-b_c.d"] {
            XCTAssertTrue(HandoffLink.isSafePath(safe), "should accept \(safe.debugDescription)")
        }
    }

    func testPathCanonicalisationStripsTheManifest() {
        XCTAssertEqual(HandoffLink.canonicalisePath("skills/demo/SKILL.md"), "skills/demo")
        XCTAssertEqual(HandoffLink.canonicalisePath("skills/demo/skill.md"), "skills/demo")
        XCTAssertEqual(HandoffLink.canonicalisePath("SKILL.md"), "")
        XCTAssertEqual(HandoffLink.canonicalisePath("skills/demo/"), "skills/demo")
        XCTAssertEqual(HandoffLink.canonicalisePath("skills/demo"), "skills/demo")
    }
}
