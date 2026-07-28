import AppUpdater
import Version
import XCTest

@testable import Sliccstart

/// Coverage for the paginated release walk in `TolerantGithubReleaseProvider`.
/// Sliccstart artifacts are built only when the launcher changes while the repo
/// releases many times a day, so the newest installable release regularly sits
/// beyond the first page of `/releases`. Stopping at page one returned an empty
/// viable list and `AppUpdater` reported "no update" while a newer installable
/// release existed.
final class ReleaseFetchPaginationTests: XCTestCase {

    private func releaseJSON(tag: String, assetName: String?) -> String {
        let assets: String
        if let assetName {
            assets = """
                [{
                  "name": "\(assetName)",
                  "browser_download_url": "https://example.com/\(assetName)",
                  "content_type": "application/zip"
                }]
                """
        } else {
            assets = "[]"
        }
        return """
            {
              "tag_name": "\(tag)",
              "prerelease": false,
              "name": "\(tag)",
              "html_url": "https://github.com/ai-ecoverse/slicc/releases/tag/\(tag)",
              "body": "test",
              "assets": \(assets)
            }
            """
    }

    /// Records requests and replays canned pages keyed by the `page` query
    /// item, advertising the next page through a GitHub-shaped `Link` header.
    private final class PageStub: @unchecked Sendable {
        private(set) var requestedURLs: [URL] = []
        private(set) var authHeaders: [String?] = []
        private let pages: [String]
        private let statusCode: Int

        init(pages: [String], statusCode: Int = 200) {
            self.pages = pages
            self.statusCode = statusCode
        }

        var fetchPage: TolerantGithubReleaseProvider.PageFetcher {
            { [self] request in
                let url = request.url!
                requestedURLs.append(url)
                authHeaders.append(request.value(forHTTPHeaderField: "Authorization"))
                let index = Self.pageIndex(of: url)
                let body = index < pages.count ? pages[index] : "[]"
                var headers: [String: String] = [:]
                if index + 1 < pages.count {
                    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
                    var items = (components.queryItems ?? []).filter { $0.name != "page" }
                    items.append(URLQueryItem(name: "page", value: String(index + 2)))
                    components.queryItems = items
                    headers["Link"] = "<\(components.url!.absoluteString)>; rel=\"next\""
                }
                let response = HTTPURLResponse(
                    url: url,
                    statusCode: statusCode,
                    httpVersion: "HTTP/1.1",
                    headerFields: headers
                )!
                return (Data(body.utf8), response)
            }
        }

        private static func pageIndex(of url: URL) -> Int {
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let raw = components?.queryItems?.first(where: { $0.name == "page" })?.value
            return max((Int(raw ?? "1") ?? 1) - 1, 0)
        }
    }

    /// Pinned so the walk's stop-at-the-running-release rule is driven by the
    /// test, not by whatever version the XCTest host bundle reports.
    private func provider(
        _ stub: PageStub,
        authToken: String? = nil,
        currentVersion: Version = Version(0, 0, 0)
    ) -> TolerantGithubReleaseProvider {
        TolerantGithubReleaseProvider(
            authToken: authToken,
            host: UpdateHostConfiguration(baseURL: URL(string: "https://api.example.com")!),
            releasePrefix: "Sliccstart",
            currentVersion: currentVersion,
            fetchPage: stub.fetchPage
        )
    }

    func testFollowsLinkHeaderUntilAViableReleaseIsFound() async throws {
        let stub = PageStub(pages: [
            "[\(releaseJSON(tag: "v5.81.1", assetName: nil)),\(releaseJSON(tag: "v5.81.0", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.80.0", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.74.0", assetName: "Sliccstart-5.74.0.zip"))]",
        ])
        let releases = try await provider(stub).fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        XCTAssertEqual(releases.map(\.tagName), [Version(5, 74, 0)])
        XCTAssertEqual(stub.requestedURLs.count, 3)
    }

    func testStopsAtFirstPageThatHasAViableRelease() async throws {
        let stub = PageStub(pages: [
            "[\(releaseJSON(tag: "v5.81.1", assetName: nil)),\(releaseJSON(tag: "v5.81.0", assetName: "Sliccstart-5.81.0.zip"))]",
            "[\(releaseJSON(tag: "v5.74.0", assetName: "Sliccstart-5.74.0.zip"))]",
        ])
        let releases = try await provider(stub).fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        XCTAssertEqual(releases.map(\.tagName), [Version(5, 81, 0)])
        XCTAssertEqual(stub.requestedURLs.count, 1, "Must not keep paginating once an installable release is found")
    }

    func testRequestsMaximumPageSizeAndKeepsAuthOnEveryPage() async throws {
        let stub = PageStub(pages: [
            "[\(releaseJSON(tag: "v5.81.0", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.74.0", assetName: "Sliccstart-5.74.0.zip"))]",
        ])
        _ = try await provider(stub, authToken: "secret-token")
            .fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        let firstQuery = URLComponents(url: stub.requestedURLs[0], resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(firstQuery?.first(where: { $0.name == "per_page" })?.value, "100")
        XCTAssertEqual(stub.authHeaders, ["Bearer secret-token", "Bearer secret-token"])
    }

    func testStopsAtThePageHoldingTheRunningRelease() async throws {
        // Nothing older than the running build can be an update, so the walk
        // must end on the page that reaches it instead of reading history.
        let stub = PageStub(pages: [
            "[\(releaseJSON(tag: "v5.81.1", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.33.0", assetName: nil)),\(releaseJSON(tag: "v5.32.10", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.32.9", assetName: "Sliccstart-5.32.9.zip"))]",
        ])
        let releases = try await provider(stub, currentVersion: Version(5, 32, 10))
            .fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        XCTAssertTrue(releases.isEmpty, "An older release must not be offered as an update")
        XCTAssertEqual(stub.requestedURLs.count, 2)
    }

    func testABackportOnAnEarlierPageDoesNotEndTheWalk() async throws {
        // `/releases` is creation-ordered, so a patch cut for an older line can
        // be published after a newer release and appear on page one. Treating
        // that as "we passed the running build" would hide the installable
        // release further back.
        let stub = PageStub(pages: [
            "[\(releaseJSON(tag: "v5.81.1", assetName: nil)),\(releaseJSON(tag: "v5.32.9", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.80.0", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.74.0", assetName: "Sliccstart-5.74.0.zip"))]",
        ])
        let releases = try await provider(stub, currentVersion: Version(5, 32, 10))
            .fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        XCTAssertEqual(releases.map(\.tagName), [Version(5, 74, 0)])
        XCTAssertEqual(stub.requestedURLs.count, 3)
    }

    func testAnUnparsableTagDoesNotEndTheWalk() async throws {
        // A non-semver tag decodes to `Version.null` (0.0.0); counting it as an
        // older release would stop the walk on page one forever.
        let stub = PageStub(pages: [
            "[\(releaseJSON(tag: "nightly", assetName: nil)),\(releaseJSON(tag: "v5.81.1", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.74.0", assetName: "Sliccstart-5.74.0.zip"))]",
        ])
        let releases = try await provider(stub, currentVersion: Version(5, 32, 10))
            .fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        XCTAssertEqual(releases.map(\.tagName), [Version(5, 74, 0)])
        XCTAssertEqual(stub.requestedURLs.count, 2)
    }

    func testStopsOncePastTheRunningVersionEvenIfItsReleaseIsGone() async throws {
        // The running build's release can be missing (deleted, or installed from
        // a build never published), so the walk must also end when a whole page
        // is older than it.
        let stub = PageStub(pages: [
            "[\(releaseJSON(tag: "v5.81.1", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.32.9", assetName: nil)),\(releaseJSON(tag: "v5.32.8", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.32.7", assetName: "Sliccstart-5.32.7.zip"))]",
        ])
        let releases = try await provider(stub, currentVersion: Version(5, 32, 10))
            .fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        XCTAssertTrue(releases.isEmpty)
        XCTAssertEqual(stub.requestedURLs.count, 2)
    }

    func testKeepsWalkingWhileEveryReleaseIsNewerThanTheRunningBuild() async throws {
        let stub = PageStub(pages: [
            "[\(releaseJSON(tag: "v5.81.1", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.80.0", assetName: nil))]",
            "[\(releaseJSON(tag: "v5.74.0", assetName: "Sliccstart-5.74.0.zip"))]",
        ])
        let releases = try await provider(stub, currentVersion: Version(5, 32, 10))
            .fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        XCTAssertEqual(releases.map(\.tagName), [Version(5, 74, 0)])
        XCTAssertEqual(stub.requestedURLs.count, 3)
    }

    func testStopsWhenTheRunningBuildIsTheNewestRelease() async throws {
        let stub = PageStub(pages: [
            "[\(releaseJSON(tag: "v5.81.1", assetName: "Sliccstart-5.81.1.zip"))]",
            "[\(releaseJSON(tag: "v5.81.0", assetName: "Sliccstart-5.81.0.zip"))]",
        ])
        let releases = try await provider(stub, currentVersion: Version(5, 81, 1))
            .fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        // The page yields a viable release, which `findViableUpdate` then
        // rejects as not-newer (`AUError.cancelled` → "Up to Date").
        XCTAssertEqual(releases.map(\.tagName), [Version(5, 81, 1)])
        XCTAssertEqual(stub.requestedURLs.count, 1)
    }

    /// The budget is the loop guard for a host that keeps advertising a next
    /// page without ever reaching the running build's release.
    func testStopsAtThePageBudgetWhenNothingIsViable() async throws {
        let pages = (0..<(TolerantGithubReleaseProvider.maxReleasePages + 3)).map { index in
            "[\(releaseJSON(tag: "v5.\(index).0", assetName: nil))]"
        }
        let stub = PageStub(pages: pages)
        let releases = try await provider(stub).fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        XCTAssertTrue(releases.isEmpty)
        XCTAssertEqual(stub.requestedURLs.count, TolerantGithubReleaseProvider.maxReleasePages)
    }

    func testThrowsOnNonSuccessStatus() async {
        let stub = PageStub(pages: ["[]"], statusCode: 403)
        do {
            _ = try await provider(stub).fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)
            XCTFail("Expected a rate-limit/forbidden response to throw")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .badServerResponse)
        }
    }

    // MARK: - Link header parsing

    func testNextPageURLParsesGithubStyleHeader() {
        let header =
            "<https://api.github.com/repositories/1/releases?per_page=100&page=2>; rel=\"next\", "
            + "<https://api.github.com/repositories/1/releases?per_page=100&page=9>; rel=\"last\""
        XCTAssertEqual(
            TolerantGithubReleaseProvider.nextPageURL(linkHeader: header)?.absoluteString,
            "https://api.github.com/repositories/1/releases?per_page=100&page=2"
        )
    }

    func testNextPageURLIgnoresOtherRelations() {
        let header = "<https://api.github.com/x?page=1>; rel=\"prev\", <https://api.github.com/x?page=9>; rel=\"last\""
        XCTAssertNil(TolerantGithubReleaseProvider.nextPageURL(linkHeader: header))
    }

    func testNextPageURLRejectsNonHTTPSchemes() {
        XCTAssertNil(TolerantGithubReleaseProvider.nextPageURL(linkHeader: "<file:///etc/passwd>; rel=\"next\""))
    }

    func testNextPageURLRejectsAForeignHost() {
        let header = "<https://evil.example/repos/o/r/releases?page=2>; rel=\"next\""
        XCTAssertNil(
            TolerantGithubReleaseProvider.nextPageURL(linkHeader: header, expectedHost: "api.github.com"),
            "The authenticated walk must not follow a Link header off the update host"
        )
        XCTAssertNotNil(
            TolerantGithubReleaseProvider.nextPageURL(linkHeader: header, expectedHost: "evil.example")
        )
    }

    func testNextPageURLHandlesMissingHeader() {
        XCTAssertNil(TolerantGithubReleaseProvider.nextPageURL(linkHeader: nil))
    }

    func testFirstPageURLPreservesExistingPageSize() {
        let url = URL(string: "https://api.example.com/repos/o/r/releases?per_page=5")!
        XCTAssertEqual(TolerantGithubReleaseProvider.firstPageURL(url), url)
    }
}
