import AsyncHTTPClient
import Foundation
import HTTPTypes
import Hummingbird
import NIOCore
import NIOHTTP1


















struct RawFetchProxy: Sendable {
    let httpClient: HTTPClient
    let secretInjector: SecretInjector
    let activityTracker: AgentActivityTracker
    var maxRequestBodyBytes = RawFetchProtocol.bridgeRequestBodyCap

    private static let requestHeader = HTTPField.Name(RawFetchProtocol.requestHeader)!
    private static let probeHeader = HTTPField.Name(RawFetchProtocol.probeHeader)!
    private static let transferEncoding = HTTPField.Name("Transfer-Encoding")!
    
    private static let upstreamTimeout: TimeAmount = .hours(24)

    
    
    static func makeHTTPClient() -> HTTPClient {
        var configuration = HTTPClient.Configuration()
        configuration.decompression = .enabled(limit: .none)
        configuration.redirectConfiguration = .disallow
        
        
        
        configuration.connectionPool.retryConnectionEstablishment = false
        configuration.networkFrameworkWaitForConnectivity = false
        return HTTPClient(eventLoopGroupProvider: .singleton, configuration: configuration)
    }

    
    
    func respond(to request: Request) async throws -> Response? {
        guard request.method == .post else { return nil }
        guard let encodedHead = request.headers[Self.requestHeader] else {
            return request.headers[Self.probeHeader] == nil ? nil : try probeResponse()
        }
        await activityTracker.recordActivity()
        return try await relay(request, encodedHead: encodedHead)
    }

    
    private func probeResponse() throws -> Response {
        let json = RawFetchProtocol.probeReplyJSON(maxRequestBodyBytes: maxRequestBodyBytes)
        return Response(
            status: .ok,
            headers: [.contentType: "application/json; charset=utf-8", .cacheControl: "no-store"],
            body: .init(byteBuffer: ByteBuffer(string: json))
        )
    }

    private enum Upload {
        case buffered(ByteBuffer)
        case streamed(RequestBody, declaredLength: Int?)
    }

    private struct Refusal: Error {
        let status: HTTPResponse.Status
        let message: String
    }

    private func relay(_ request: Request, encodedHead: String) async throws -> Response {
        do {
            guard let head = RawFetchProtocol.decodeRequestHead(encodedHead) else {
                throw Refusal(status: .badRequest, message: "Malformed \(RawFetchProtocol.requestHeader) header")
            }
            let upstreamRequest = try await prepareUpstream(request, head: head)
            let upstream: HTTPClientResponse
            do {
                upstream = try await httpClient.execute(upstreamRequest, timeout: Self.upstreamTimeout)
            } catch {
                throw Refusal(status: .badGateway, message: "Proxy fetch failed: \(error)")
            }
            return try frame(upstream, for: head)
        } catch let refusal as Refusal {
            var response = try rawProxyError(status: refusal.status, message: refusal.message)
            
            
            
            
            if refusal.status == .contentTooLarge { response.headers[.connection] = "close" }
            return response
        }
    }

    
    private func prepareUpstream(_ request: Request, head: RawFetchRequestHead) async throws -> HTTPClientRequest {
        let folded = RawFetchProtocol.foldRequestHeaders(RawFetchProtocol.stripRequestHeaders(head.headers))
        var fields = HTTPFields()
        var hmacSpec: String?
        for pair in folded {
            if pair.name == RawFetchProtocol.hmacSignHeader {
                hmacSpec = pair.value
                continue
            }
            guard let name = HTTPField.Name(pair.name) else {
                throw Refusal(status: .badRequest, message: "Invalid header name \"\(pair.name)\"")
            }
            fields.append(HTTPField(name: name, value: pair.value))
        }
        fields[.acceptEncoding] = RawFetchProtocol.acceptEncoding(for: folded)

        let hostname = secretScopeHostname(head.url)
        let urlCreds = secretInjector.extractAndUnmaskUrlCredentials(rawUrl: head.url)
        if let forbidden = urlCreds.forbidden {
            throw Refusal(status: .forbidden, message: forbiddenSecretMessage(forbidden))
        }
        var injected = fields
        if let forbidden = unmaskRequestHeaders(fields, into: &injected, hostname: hostname, injector: secretInjector) {
            throw Refusal(status: .forbidden, message: forbiddenSecretMessage(forbidden))
        }
        if let synthetic = urlCreds.syntheticAuthorization, injected[.authorization] == nil {
            injected[.authorization] = synthetic
        }

        var upstream = HTTPClientRequest(url: urlCreds.url)
        upstream.method = HTTPMethod(rawValue: head.method)
        switch try await readUpload(request, head: head) {
        case .streamed(let body, let declaredLength):
            upstream.body = .stream(body, length: declaredLength.map { .known(Int64($0)) } ?? .unknown)
        case .buffered(var body):
            let method = head.method.uppercased()
            if method == "GET" || method == "HEAD" { body = ByteBuffer() }
            body = unmaskRequestBody(
                body,
                contentType: injected[.contentType] ?? "",
                hostname: hostname,
                injector: secretInjector
            )
            if let hmacSpec,
                let forbidden = applyHmacSigning(
                    spec: hmacSpec, body: body, headers: &injected, hostname: hostname, injector: secretInjector)
            {
                throw Refusal(status: .forbidden, message: forbiddenSecretMessage(forbidden))
            }
            if body.readableBytes > 0 { upstream.body = .bytes(body) }
        }
        upstream.headers = HTTPHeaders(injected.map { ($0.name.rawName, $0.value) })
        return upstream
    }

    
    
    private func readUpload(_ request: Request, head: RawFetchRequestHead) async throws -> Upload {
        let method = head.method.uppercased()
        let chunked = request.headers[.contentLength] == nil && request.headers[Self.transferEncoding] != nil
        if chunked, method != "GET", method != "HEAD",
            RawFetchProtocol.uploadStreams(headers: head.headers, bodyLength: nil, canStream: true)
        {
            return .streamed(request.body, declaredLength: declaredLength(head))
        }
        let tooLarge = Refusal(
            status: .contentTooLarge,
            message: "Request body exceeds the \(maxRequestBodyBytes) byte limit of this float"
        )
        if let declared = request.headers[.contentLength].flatMap(Int.init), declared > maxRequestBodyBytes {
            throw tooLarge
        }
        do {
            return .buffered(try await request.body.collect(upTo: maxRequestBodyBytes))
        } catch let error as HTTPError where error.status == .contentTooLarge {
            throw tooLarge
        }
    }

    
    private func declaredLength(_ head: RawFetchRequestHead) -> Int? {
        head.headers.first { $0.name.lowercased() == "content-length" }
            .flatMap { Int($0.value.trimmingCharacters(in: .whitespaces)) }
            .flatMap { $0 >= 0 ? $0 : nil }
    }

    
    private func frame(_ upstream: HTTPClientResponse, for head: RawFetchRequestHead) throws -> Response {
        let status = Int(upstream.status.code)
        let upstreamHeaders = upstream.headers.map { RawHeaderPair($0.name.lowercased(), $0.value) }
        let hasBody = RawFetchProtocol.responseHasBody(method: head.method, status: status)
        let decoding = RawFetchProtocol.upstreamDecoding(upstreamHeaders)
        let decodedCodings = decoding == .decoded ? RawFetchProtocol.decodedCodings : []
        if hasBody, decoding == .partiallyDecoded {
            throw Refusal(status: .badGateway, message: "Upstream stacked a content coding this float cannot undo")
        }
        if RawFetchProtocol.isDecodedPartialResponse(
            status: status, headers: upstreamHeaders, decodedCodings: decodedCodings)
        {
            throw Refusal(status: .badGateway, message: "Upstream answered a range request with an encoded partial body")
        }
        
        
        let contentType = upstreamHeaders.first { $0.name == "content-type" }?.value ?? ""
        let isText = isTextContentType(contentType)
        let headers = RawFetchProtocol.responseHeaders(
            method: head.method,
            status: status,
            headers: upstreamHeaders,
            bodyRewritten: isText,
            decodedCodings: decodedCodings
        ).map { RawHeaderPair($0.name, secretInjector.scrub(text: $0.value)) }
        let frame = RawFetchProtocol.encodeResponseFrame(
            RawFetchResponseHead(status: status, statusText: upstream.status.reasonPhrase, headers: headers, url: head.url)
        )
        let body =
            hasBody
            ? ScrubbingAsyncStream(
                upstream: upstream.body,
                shouldScrub: isText && !secretInjector.isEmpty,
                shouldGunzip: isText,
                scrubber: secretInjector
            )
            : nil
        return Response(
            status: .ok,
            headers: [.contentType: RawFetchProtocol.contentType, .cacheControl: "no-store, no-cache"],
            body: ResponseBody(asyncSequence: FramedBody(frame: ByteBuffer(bytes: frame), body: body))
        )
    }
}


struct FramedBody: AsyncSequence, Sendable {
    typealias Element = ByteBuffer
    let frame: ByteBuffer
    let body: ScrubbingAsyncStream?

    struct AsyncIterator: AsyncIteratorProtocol {
        var frame: ByteBuffer?
        var body: ScrubbingAsyncStream.AsyncIterator?

        mutating func next() async throws -> ByteBuffer? {
            if let pending = frame {
                frame = nil
                return pending
            }
            return try await body?.next()
        }
    }

    func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(frame: frame, body: body?.makeAsyncIterator())
    }
}


private func rawProxyError(status: HTTPResponse.Status, message: String) throws -> Response {
    let data = try JSONSerialization.data(withJSONObject: ["error": message])
    return Response(
        status: status,
        headers: [
            .contentType: "application/json; charset=utf-8",
            HTTPField.Name("X-Proxy-Error")!: "1",
        ],
        body: .init(byteBuffer: ByteBuffer(data: data))
    )
}
