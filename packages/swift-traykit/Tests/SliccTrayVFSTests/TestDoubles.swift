import FileProvider
import Foundation
import SliccTrayFollower
import WebRTC
import XCTest

@testable import SliccTrayVFS

@MainActor
final class FakeFS: FileProviderFSClient {
    var directories: [String: [TrayFsDirEntry]] = [:]
    var stats: [String: TrayFsStat] = [:]
    var files: [String: Data] = [:]
    var error: Error?
    var removeErrors: [String: Error] = [:]
    private(set) var operations: [String] = []

    func readBinaryFile(_ path: String) async throws -> Data {
        operations.append("read:\(path)")
        if let error { throw error }
        guard let data = files[path] else {
            throw FsClient.FsError.leader(message: "missing", code: "ENOENT")
        }
        return data
    }

    func writeBinaryFile(_ path: String, data: Data) async throws {
        operations.append("write:\(path):\(data.base64EncodedString())")
        if let error { throw error }
        files[path] = data
        stats[path] = TrayFsStat(type: .file, size: data.count, mtime: 2, ctime: 1)
        addEntry(path, type: .file)
    }

    func readDir(_ path: String) async throws -> [TrayFsDirEntry] {
        operations.append("dir:\(path)")
        if let error { throw error }
        guard let entries = directories[path] else {
            throw FsClient.FsError.leader(message: "missing", code: "ENOENT")
        }
        return entries
    }

    func stat(_ path: String) async throws -> TrayFsStat {
        operations.append("stat:\(path)")
        if let error { throw error }
        guard let stat = stats[path] else {
            throw FsClient.FsError.leader(message: "missing", code: "ENOENT")
        }
        return stat
    }

    func mkdir(_ path: String, recursive: Bool) async throws {
        operations.append("mkdir:\(path):\(recursive)")
        if let error { throw error }
        directories[path] = directories[path] ?? []
        stats[path] = TrayFsStat(type: .directory, size: 0, mtime: 2, ctime: 1)
        addEntry(path, type: .directory)
    }

    func remove(_ path: String, recursive: Bool) async throws {
        operations.append("rm:\(path):\(recursive)")
        if let removeError = removeErrors[path] { throw removeError }
        if let error { throw error }
        let prefix = path + "/"
        if directories[path]?.isEmpty == false && !recursive {
            throw FsClient.FsError.leader(message: "not empty", code: "ENOTEMPTY")
        }
        guard stats[path] != nil || files[path] != nil || directories[path] != nil else {
            throw FsClient.FsError.leader(message: "missing", code: "ENOENT")
        }
        files = files.filter { $0.key != path && !$0.key.hasPrefix(prefix) }
        stats = stats.filter { $0.key != path && !$0.key.hasPrefix(prefix) }
        directories = directories.filter { $0.key != path && !$0.key.hasPrefix(prefix) }
        let parent = (path as NSString).deletingLastPathComponent
        let name = (path as NSString).lastPathComponent
        directories[parent.isEmpty ? "/" : parent]?.removeAll { $0.name == name }
    }

    private func addEntry(_ path: String, type: TrayFsNodeType) {
        let parent = (path as NSString).deletingLastPathComponent
        let parentPath = parent.isEmpty ? "/" : parent
        let name = (path as NSString).lastPathComponent
        var entries = directories[parentPath] ?? []
        if !entries.contains(where: { $0.name == name }) {
            entries.append(TrayFsDirEntry(name: name, type: type))
        }
        directories[parentPath] = entries
    }
}

@MainActor
final class FakeConnection: FileProviderFSConnection {
    let fs: FakeFS
    private(set) var disconnected = false

    init(fs: FakeFS) { self.fs = fs }
    func readBinaryFile(_ path: String) async throws -> Data { try await fs.readBinaryFile(path) }
    func writeBinaryFile(_ path: String, data: Data) async throws {
        try await fs.writeBinaryFile(path, data: data)
    }
    func readDir(_ path: String) async throws -> [TrayFsDirEntry] { try await fs.readDir(path) }
    func stat(_ path: String) async throws -> TrayFsStat { try await fs.stat(path) }
    func mkdir(_ path: String, recursive: Bool) async throws {
        try await fs.mkdir(path, recursive: recursive)
    }
    func remove(_ path: String, recursive: Bool) async throws {
        try await fs.remove(path, recursive: recursive)
    }
    func disconnect() { disconnected = true }
}

@MainActor
final class FakeTrayConnector: FileProviderTrayConnector {
    var delegate: TrayFollowerConnectorDelegate?
    var sendSucceeds = true
    var startError: Error?
    var hangStart = false
    private(set) var sent: [Data] = []
    private(set) var stopCount = 0
    private var startContinuation: CheckedContinuation<Void, Error>?
    let callbackConnector = TrayFollowerConnector(
        joinUrl: URL(string: "https://tray.example/join/redacted")!)

    func start() async throws {
        if let startError { throw startError }
        if hangStart {
            try await withCheckedThrowingContinuation { continuation in
                startContinuation = continuation
            }
            return
        }
        delegate?.connector(
            callbackConnector,
            didConnect: { [weak self] data in
                self?.sent.append(data)
                return self?.sendSucceeds ?? false
            })
    }

    func stop() {
        stopCount += 1
        startContinuation?.resume(throwing: CancellationError())
        startContinuation = nil
    }

    func receive(_ data: Data) {
        delegate?.connector(callbackConnector, didReceiveData: data)
    }

    func disconnect(reason: String = "test disconnect") {
        delegate?.connectorDidDisconnect(callbackConnector, reason: reason)
    }

    func giveUp(_ lastError: String) {
        delegate?.connector(callbackConnector, didGiveUp: lastError)
    }

    func announceReconnect(attempt: Int) {
        delegate?.connector(callbackConnector, isReconnecting: attempt)
    }

    func announceInfo(trayId: String, participantCount: Int) {
        delegate?.connector(callbackConnector, didReceiveInfo: trayId, participantCount: participantCount)
    }

    func announceCandidate() {
        delegate?.connector(
            callbackConnector,
            didGenerateCandidate: RTCIceCandidate(sdp: "candidate:0 1 UDP", sdpMLineIndex: 0, sdpMid: "0"))
    }
}

final class RecordingChangeObserver: NSObject, NSFileProviderChangeObserver {
    private(set) var updated: [any NSFileProviderItem] = []
    private(set) var deleted: [NSFileProviderItemIdentifier] = []
    private(set) var error: Error?
    private(set) var finished = false
    private(set) var anchor: NSFileProviderSyncAnchor?

    func didUpdate(_ updatedItems: [any NSFileProviderItem]) { updated = updatedItems }
    func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) {
        deleted = deletedItemIdentifiers
    }
    func finishEnumeratingChanges(upTo anchor: NSFileProviderSyncAnchor, moreComing _: Bool) {
        self.anchor = anchor
        finished = true
    }
    func finishEnumeratingWithError(_ error: any Error) {
        self.error = error
        finished = true
    }
}

final class RecordingEnumerationObserver: NSObject, NSFileProviderEnumerationObserver {
    private(set) var items: [any NSFileProviderItem] = []
    private(set) var error: Error?
    private(set) var finished = false

    func didEnumerate(_ updatedItems: [any NSFileProviderItem]) { items = updatedItems }
    func finishEnumerating(upTo _: NSFileProviderPage?) { finished = true }
    func finishEnumeratingWithError(_ error: any Error) {
        self.error = error
        finished = true
    }
}

func testCredentials() throws -> TrayCredentials {
    TrayCredentials(
        joinURL: try XCTUnwrap(URL(string: "https://tray.example/join/redacted")),
        trayID: "tray", displayName: nil, lastConnectedAt: Date())
}

func waitUntilFinished(_ isFinished: @autoclosure () -> Bool, tries: Int = 200) async {
    for _ in 0..<tries where !isFinished() {
        await Task.yield()
    }
}

func assertMapped(
    _ error: Error,
    is expected: NSFileProviderError.Code,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let mapped = VFSProviderErrorMapper.map(error) as NSError
    XCTAssertEqual(mapped.domain, NSFileProviderErrorDomain, file: file, line: line)
    XCTAssertEqual(mapped.code, expected.rawValue, file: file, line: line)
}

func assertMappedFailure(
    _ expected: NSFileProviderError.Code,
    file: StaticString = #filePath,
    line: UInt = #line,
    operation: () async throws -> Void
) async {
    do {
        try await operation()
        XCTFail("expected mapped error \(expected)", file: file, line: line)
    } catch {
        let mapped = VFSProviderErrorMapper.map(error) as NSError
        XCTAssertEqual(mapped.domain, NSFileProviderErrorDomain, file: file, line: line)
        XCTAssertEqual(mapped.code, expected.rawValue, file: file, line: line)
    }
}

func assertVFSFailure(
    _ expected: VFSProviderError,
    file: StaticString = #filePath,
    line: UInt = #line,
    operation: () async throws -> Void
) async {
    do {
        try await operation()
        XCTFail("expected \(expected)", file: file, line: line)
    } catch let error as VFSProviderError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("unexpected error \(error)", file: file, line: line)
    }
}

func assertFsFailure(
    _ expected: FsClient.FsError,
    file: StaticString = #filePath,
    line: UInt = #line,
    operation: () async throws -> Void
) async {
    do {
        try await operation()
        XCTFail("expected \(expected)", file: file, line: line)
    } catch let error as FsClient.FsError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("unexpected error \(error)", file: file, line: line)
    }
}
