import XCTest
@testable import slicc_server

final class PortResolverTests: XCTestCase {
    func testReturnsPreferredPortWhenItIsFree() async throws {
        let reserved = try makeReservedSocket()
        let freePort = reserved.port
        close(reserved.fd)

        let resolvedPort = try await findAvailablePort(startingFrom: freePort)
        XCTAssertEqual(resolvedPort, freePort)
    }

    func testSkipsOccupiedPort() async throws {
        let reserved = try makeReservedSocket()
        defer { close(reserved.fd) }

        let resolvedPort = try await findAvailablePort(startingFrom: reserved.port)
        XCTAssertNotEqual(resolvedPort, reserved.port)
        XCTAssertGreaterThan(resolvedPort, reserved.port)
    }

    private func makeReservedSocket() throws -> (fd: Int32, port: Int) {
        let socket = try makeListeningSocket(port: 0)
        return socket
    }

    private func makeListeningSocket(port: Int) throws -> (fd: Int32, port: Int) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0)

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.stride)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        let conversion = withUnsafeMutablePointer(to: &address.sin_addr) {
            inet_pton(AF_INET, "127.0.0.1", $0)
        }
        XCTAssertEqual(conversion, 1)

        let bindResult = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.stride))
            }
        }
        XCTAssertEqual(bindResult, 0)
        XCTAssertEqual(Darwin.listen(fd, 1), 0)

        var storage = sockaddr_storage()
        var length = socklen_t(MemoryLayout<sockaddr_storage>.stride)
        let result = withUnsafeMutablePointer(to: &storage) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &length)
            }
        }
        XCTAssertEqual(result, 0)

        let assignedPort = withUnsafePointer(to: &storage) {
            $0.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                Int(UInt16(bigEndian: $0.pointee.sin_port))
            }
        }
        return (fd, assignedPort)
    }
}