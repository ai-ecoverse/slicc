import Dispatch
import Hummingbird
import Logging

struct RequestLogger<Context: RequestContext>: RouterMiddleware {
    private let logger: Logger

    init(logger: Logger = Logger(label: "slicc.request")) {
        self.logger = logger
    }

    func handle(_ request: Request, context: Context, next: (Request, Context) async throws -> Response) async throws -> Response {
        let start = DispatchTime.now().uptimeNanoseconds

        do {
            let response = try await next(request, context)
            self.log(method: request.method.rawValue, path: request.uri.path, status: response.status.code, start: start)
            return response
        } catch {
            let status = (error as? any HTTPResponseError)?.status.code ?? 500
            self.log(method: request.method.rawValue, path: request.uri.path, status: status, start: start)
            throw error
        }
    }

    private func log(method: String, path: String, status: Int, start: UInt64) {
        let durationMs = (DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
        logger.info("\(Self.coloredStatusCode(status)) \(method) \(path) \(durationMs)ms")
    }
}

extension RequestLogger {
    static var green: String { "\u{1b}[32m" }
    static var yellow: String { "\u{1b}[33m" }
    static var red: String { "\u{1b}[31m" }
    static var reset: String { "\u{1b}[0m" }

    static func coloredStatusCode(_ status: Int) -> String {
        let color = colorPrefix(for: status)
        return "\(color)\(status)\(reset)"
    }

    static func colorPrefix(for status: Int) -> String {
        switch status {
        case 200..<300:
            green
        case 300..<400:
            yellow
        case 400...:
            red
        default:
            reset
        }
    }
}