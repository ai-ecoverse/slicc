import Darwin
import Foundation

/// Minimal HTTP/1.1 server bound to a random port on the loopback
/// interface. Test target only — exists so we can exercise the real
/// `URLSession` + JSON parsing path used by the update machinery instead
/// of stubbing out network calls. Past updater regressions came from URL
/// construction and header bugs that no in-memory mock would have caught.
///
/// Implemented with POSIX sockets rather than `Network.framework` because
/// `NWListener` returned EINVAL when bound to an OS-assigned port under
/// `swift test`, which would have made these tests flaky.
final class FakeUpdateServer {
    struct Response {
        var status: Int
        var contentType: String
        var body: Data

        init(status: Int = 200, contentType: String = "application/json", body: Data = Data()) {
            self.status = status
            self.contentType = contentType
            self.body = body
        }

        static func json(_ object: Any, status: Int = 200) -> Response {
            let body = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
            return Response(status: status, contentType: "application/json", body: body)
        }

        static func bytes(_ data: Data, contentType: String = "application/octet-stream", status: Int = 200) -> Response {
            Response(status: status, contentType: contentType, body: data)
        }

        static func text(_ string: String, status: Int = 200) -> Response {
            Response(status: status, contentType: "text/plain", body: Data(string.utf8))
        }

        static let notFound = Response(status: 404, contentType: "text/plain", body: Data("Not Found".utf8))
        static let serverError = Response(status: 500, contentType: "text/plain", body: Data("Internal Server Error".utf8))
    }

    struct RecordedRequest: Equatable {
        let method: String
        let path: String
        let headers: [String: String]
    }

    typealias Handler = (RecordedRequest) -> Response

    private let listenSocket: Int32
    let port: UInt16
    private let workerQueue: DispatchQueue
    private let acceptSource: DispatchSourceRead
    private let stateLock = NSLock()
    private var handlers: [(method: String, path: String, handler: Handler)] = []
    private var recordedRequests: [RecordedRequest] = []
    private var stopped = false

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    private init(listenSocket: Int32, port: UInt16, acceptSource: DispatchSourceRead, workerQueue: DispatchQueue) {
        self.listenSocket = listenSocket
        self.port = port
        self.acceptSource = acceptSource
        self.workerQueue = workerQueue
    }

    static func start() throws -> FakeUpdateServer {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard fd >= 0 else {
            throw FakeUpdateServerError(message: "socket() failed: \(String(cString: strerror(errno)))")
        }

        var reuse: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout.size(ofValue: reuse)))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(0).bigEndian   // OS assigns
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.bind(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            let err = String(cString: strerror(errno))
            Darwin.close(fd)
            throw FakeUpdateServerError(message: "bind() failed: \(err)")
        }

        guard Darwin.listen(fd, 16) == 0 else {
            let err = String(cString: strerror(errno))
            Darwin.close(fd)
            throw FakeUpdateServerError(message: "listen() failed: \(err)")
        }

        var assignedAddr = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &assignedAddr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                getsockname(fd, sockPtr, &len)
            }
        }
        guard nameResult == 0 else {
            let err = String(cString: strerror(errno))
            Darwin.close(fd)
            throw FakeUpdateServerError(message: "getsockname() failed: \(err)")
        }
        let assignedPort = UInt16(bigEndian: assignedAddr.sin_port)

        let queue = DispatchQueue(label: "FakeUpdateServer", qos: .userInitiated, attributes: .concurrent)
        let acceptSource = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        let server = FakeUpdateServer(listenSocket: fd, port: assignedPort, acceptSource: acceptSource, workerQueue: queue)

        acceptSource.setEventHandler { [weak server] in
            guard let server, !server.isStopped() else { return }
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientFD = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    Darwin.accept(fd, sockPtr, &clientLen)
                }
            }
            guard clientFD >= 0 else { return }
            server.handleConnection(fd: clientFD)
        }
        acceptSource.resume()

        return server
    }

    func stop() {
        stateLock.lock()
        stopped = true
        stateLock.unlock()
        acceptSource.cancel()
        Darwin.close(listenSocket)
    }

    func handle(_ method: String, _ path: String, _ handler: @escaping Handler) {
        stateLock.lock()
        handlers.removeAll { $0.method.uppercased() == method.uppercased() && $0.path == path }
        handlers.append((method.uppercased(), path, handler))
        stateLock.unlock()
    }

    func respond(_ method: String, _ path: String, _ response: Response) {
        handle(method, path) { _ in response }
    }

    func recordedRequestsSnapshot() -> [RecordedRequest] {
        stateLock.lock()
        defer { stateLock.unlock() }
        return recordedRequests
    }

    func clearRecorded() {
        stateLock.lock()
        recordedRequests.removeAll()
        stateLock.unlock()
    }

    // MARK: - Internals

    private func isStopped() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stopped
    }

    private func handleConnection(fd: Int32) {
        workerQueue.async { [weak self] in
            defer { Darwin.close(fd) }
            guard let self else { return }

            // Read request bytes until we see the end-of-headers marker.
            // HTTP/1.1 with `Connection: close` so we don't need to parse
            // bodies or implement keep-alive.
            var buffer = Data()
            let bufferLimit = 256 * 1024
            while buffer.count < bufferLimit {
                var chunk = [UInt8](repeating: 0, count: 4096)
                let read = chunk.withUnsafeMutableBytes { ptr -> Int in
                    Darwin.read(fd, ptr.baseAddress, ptr.count)
                }
                if read <= 0 { break }
                buffer.append(contentsOf: chunk.prefix(read))
                if buffer.range(of: Data("\r\n\r\n".utf8)) != nil { break }
            }

            guard let parsed = self.parseRequest(buffer) else {
                self.send(response: .text("Bad Request", status: 400), to: fd)
                return
            }

            self.stateLock.lock()
            self.recordedRequests.append(parsed)
            let routePath = parsed.path
                .split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
                .first.map(String.init) ?? parsed.path
            let matched = self.handlers.last { entry in
                entry.method == parsed.method.uppercased() && entry.path == routePath
            }
            self.stateLock.unlock()

            let response: Response = matched?.handler(parsed) ?? .notFound
            self.send(response: response, to: fd)
        }
    }

    private func parseRequest(_ buffer: Data) -> RecordedRequest? {
        guard let headerRange = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let headerString = String(data: buffer.subdata(in: 0..<headerRange.lowerBound), encoding: .utf8) else {
            return nil
        }
        let lines = headerString.split(separator: "\r\n", omittingEmptySubsequences: false).map(String.init)
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ").map(String.init)
        guard parts.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
            if let colon = line.firstIndex(of: ":") {
                let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces).lowercased()
                let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
                headers[key] = value
            }
        }
        return RecordedRequest(method: parts[0], path: parts[1], headers: headers)
    }

    private func send(response: Response, to fd: Int32) {
        let statusText = HTTPStatus.text(for: response.status)
        var header = "HTTP/1.1 \(response.status) \(statusText)\r\n"
        header += "Content-Type: \(response.contentType)\r\n"
        header += "Content-Length: \(response.body.count)\r\n"
        header += "Connection: close\r\n"
        header += "\r\n"

        var bytes = Data(header.utf8)
        bytes.append(response.body)
        bytes.withUnsafeBytes { rawBuffer in
            var sent = 0
            let base = rawBuffer.baseAddress!
            while sent < bytes.count {
                let result = Darwin.send(fd, base.advanced(by: sent), bytes.count - sent, 0)
                if result <= 0 { break }
                sent += result
            }
        }
    }
}

private struct FakeUpdateServerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private enum HTTPStatus {
    static func text(for code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 204: return "No Content"
        case 301: return "Moved Permanently"
        case 302: return "Found"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 500: return "Internal Server Error"
        case 503: return "Service Unavailable"
        default: return "OK"
        }
    }
}
