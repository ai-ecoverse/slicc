import XCTest
@testable import Sliccstart

final class SliccCliDownloaderTests: XCTestCase {
    private var tempDirectory: URL!

    override func setUpWithError() throws {
        tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        CliURLProtocolStub.handler = nil
    }

    override func tearDownWithError() throws {
        CliURLProtocolStub.handler = nil
        if let tempDirectory { try? FileManager.default.removeItem(at: tempDirectory) }
    }

    func testSuccessfulDownloadUsesArchitectureRouteAndReportsProgress() async throws {
        var requestedURL: URL?
        var signatureValidated = false
        CliURLProtocolStub.handler = { request in
            requestedURL = request.url
            return (Self.response(for: request, status: 200), Data("cli-binary".utf8))
        }
        var progress: [SliccCliDownloadProgress] = []
        let downloader = makeDownloader(
            signatureValidator: { _ in signatureValidated = true },
            versionValidator: { _ in
                XCTAssertTrue(signatureValidated, "Signature validation must precede execution")
                return true
            },
            progressHandler: { progress.append($0) }
        )

        let result = try await downloader.download(architecture: .arm64)

        XCTAssertEqual(requestedURL?.absoluteString, "https://download.test/darwin-arm64")
        XCTAssertEqual(try Data(contentsOf: result), Data("cli-binary".utf8))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: result.path))
        XCTAssertTrue(signatureValidated)
        XCTAssertEqual(progress.first, .preparing)
        XCTAssertTrue(progress.contains(.validating))
        XCTAssertTrue(progress.contains(.installing))
        XCTAssertEqual(progress.last, .finished(result))
    }

    func testNetworkFailureRetriesThenReturnsTypedError() async {
        var attempts = 0
        CliURLProtocolStub.handler = { _ in
            attempts += 1
            throw URLError(.notConnectedToInternet)
        }
        let downloader = makeDownloader(maxAttempts: 3)

        await assertDownloadError(.networkFailure, from: downloader)

        XCTAssertEqual(attempts, 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testNonSuccessResponseReturnsStatusError() async {
        CliURLProtocolStub.handler = { request in
            (Self.response(for: request, status: 404), Data("missing".utf8))
        }

        await assertDownloadError(.invalidResponse(statusCode: 404), from: makeDownloader())
    }

    func testUnfollowedRedirectReturnsStatusError() async {
        CliURLProtocolStub.handler = { request in
            (Self.response(for: request, status: 302), Data())
        }

        await assertDownloadError(.invalidResponse(statusCode: 302), from: makeDownloader())
    }

    func testContentLengthMismatchReturnsTruncatedError() async {
        CliURLProtocolStub.handler = { request in
            let response = Self.response(for: request, status: 200, headers: ["Content-Length": "20"])
            return (response, Data("short".utf8))
        }

        await assertDownloadError(
            .truncatedDownload(expectedBytes: 20, actualBytes: 5),
            from: makeDownloader()
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testEmptyDownloadReturnsTruncatedError() async {
        CliURLProtocolStub.handler = { request in
            (Self.response(for: request, status: 200), Data())
        }

        await assertDownloadError(
            .truncatedDownload(expectedBytes: nil, actualBytes: 0),
            from: makeDownloader()
        )
    }

    func testNonExecutableStagingFileIsRejectedAndRemoved() async {
        stubSuccessfulResponse()
        let downloader = makeDownloader(permissionsApplier: { _ in })

        await assertDownloadError(.nonExecutableResult, from: downloader)

        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertTrue(stagingFiles.isEmpty)
    }

    func testFailingVersionCheckIsRejectedAndRemoved() async {
        stubSuccessfulResponse()
        let downloader = makeDownloader(versionValidator: { _ in false })

        await assertDownloadError(.versionCheckFailed, from: downloader)

        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertTrue(stagingFiles.isEmpty)
    }

    func testUnsignedOrTamperedSignatureIsRejectedBeforeVersionExecution() async {
        stubSuccessfulResponse()
        var versionExecuted = false
        let downloader = makeDownloader(
            signatureValidator: { _ in throw SliccCliDownloadError.invalidCodeSignature },
            versionValidator: { _ in
                versionExecuted = true
                return true
            }
        )

        await assertDownloadError(.invalidCodeSignature, from: downloader)

        XCTAssertFalse(versionExecuted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertTrue(stagingFiles.isEmpty)
    }

    func testWrongSigningTeamIsRejectedBeforeVersionExecution() async {
        stubSuccessfulResponse()
        let expectedTeam = SliccCliCodeSignatureValidator.expectedTeamIdentifier
        let downloader = makeDownloader(signatureValidator: { _ in
            throw SliccCliDownloadError.unexpectedSigningTeam(expected: expectedTeam, actual: "WRONGTEAM1")
        })

        await assertDownloadError(
            .unexpectedSigningTeam(expected: expectedTeam, actual: "WRONGTEAM1"),
            from: downloader
        )

        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertTrue(stagingFiles.isEmpty)
    }

    func testCodeSignatureValidatorAcceptsExpectedTeamInspection() throws {
        try SliccCliCodeSignatureValidator.validate(destination) { _ in
            SliccCliCodeSignatureInspection(
                hasValidDeveloperIDSignature: true,
                teamIdentifier: SliccCliCodeSignatureValidator.expectedTeamIdentifier
            )
        }
    }

    func testCodeSignatureValidatorClassifiesInvalidAndWrongTeamInspections() {
        XCTAssertThrowsError(try SliccCliCodeSignatureValidator.validate(destination) { _ in
            SliccCliCodeSignatureInspection(hasValidDeveloperIDSignature: false, teamIdentifier: nil)
        }) { error in
            XCTAssertEqual(error as? SliccCliDownloadError, .invalidCodeSignature)
        }

        XCTAssertThrowsError(try SliccCliCodeSignatureValidator.validate(destination) { _ in
            SliccCliCodeSignatureInspection(hasValidDeveloperIDSignature: true, teamIdentifier: "OTHERTEAM1")
        }) { error in
            XCTAssertEqual(
                error as? SliccCliDownloadError,
                .unexpectedSigningTeam(
                    expected: SliccCliCodeSignatureValidator.expectedTeamIdentifier,
                    actual: "OTHERTEAM1"
                )
            )
        }
    }

    func testProductionCodeSignatureValidatorRejectsUnsignedFile() throws {
        try Data("not-a-signed-binary".utf8).write(to: destination)

        XCTAssertThrowsError(try SliccCliCodeSignatureValidator.validate(destination)) { error in
            XCTAssertEqual(error as? SliccCliDownloadError, .invalidCodeSignature)
        }
    }

    func testExistingExecutableIsReturnedWithoutNetworkRequest() async throws {
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        try Data("existing".utf8).write(to: destination)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path)
        CliURLProtocolStub.handler = { _ in XCTFail("Network should not be used"); throw URLError(.badURL) }

        let result = try await makeDownloader().download()

        XCTAssertEqual(result, destination)
        XCTAssertEqual(try Data(contentsOf: result), Data("existing".utf8))
    }

    private var destination: URL { tempDirectory.appendingPathComponent("slicc") }

    private var stagingFiles: [URL] {
        (try? FileManager.default.contentsOfDirectory(
            at: tempDirectory,
            includingPropertiesForKeys: nil
        ).filter { $0.lastPathComponent.hasPrefix(".slicc.download-") }) ?? []
    }

    private func makeDownloader(
        maxAttempts: Int = 1,
        permissionsApplier: @escaping SliccCliDownloader.PermissionsApplier = {
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: $0.path)
        },
        signatureValidator: @escaping SliccCliDownloader.SignatureValidator = { _ in },
        versionValidator: @escaping SliccCliDownloader.VersionValidator = { _ in true },
        progressHandler: @escaping SliccCliDownloader.ProgressHandler = { _ in }
    ) -> SliccCliDownloader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CliURLProtocolStub.self]
        return SliccCliDownloader(
            session: URLSession(configuration: configuration),
            installDirectory: tempDirectory,
            baseURL: URL(string: "https://download.test")!,
            requestTimeout: 0.1,
            maxAttempts: maxAttempts,
            retryDelayNanoseconds: 0,
            permissionsApplier: permissionsApplier,
            signatureValidator: signatureValidator,
            versionValidator: versionValidator,
            progressHandler: progressHandler
        )
    }

    private func assertDownloadError(
        _ expected: SliccCliDownloadError,
        from downloader: SliccCliDownloader,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            _ = try await downloader.download(architecture: .amd64)
            XCTFail("Expected download to fail", file: file, line: line)
        } catch let error as SliccCliDownloadError {
            XCTAssertEqual(error, expected, file: file, line: line)
            XCTAssertNotNil(error.errorDescription, file: file, line: line)
        } catch {
            XCTFail("Unexpected error: \(error)", file: file, line: line)
        }
    }

    private func stubSuccessfulResponse() {
        CliURLProtocolStub.handler = { request in
            (Self.response(for: request, status: 200), Data("cli-binary".utf8))
        }
    }

    private static func response(
        for request: URLRequest,
        status: Int,
        headers: [String: String]? = nil
    ) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
    }
}

private final class CliURLProtocolStub: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    // URLProtocol requires overridable class methods even though this test stub is final.
    // swiftlint:disable:next static_over_final_class
    override class func canInit(with request: URLRequest) -> Bool { true }
    // swiftlint:disable:next static_over_final_class
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
