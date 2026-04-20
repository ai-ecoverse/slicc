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

    func testStrictModeThrowsWhenPreferredPortIsOccupied() async throws {
        let reserved = try makeReservedSocket()
        defer { close(reserved.fd) }

        do {
            let resolved = try await findAvailablePort(startingFrom: reserved.port, strict: true)
            XCTFail("expected preferredPortUnavailable but got port \(resolved)")
        } catch PortResolverError.preferredPortUnavailable(let port) {
            XCTAssertEqual(port, reserved.port)
        } catch {
            XCTFail("expected preferredPortUnavailable but got \(error)")
        }
    }

    func testStrictModeReturnsPreferredPortWhenItIsFree() async throws {
        let reserved = try makeReservedSocket()
        let freePort = reserved.port
        close(reserved.fd)

        let resolvedPort = try await findAvailablePort(startingFrom: freePort, strict: true)
        XCTAssertEqual(resolvedPort, freePort)
    }

    func testStrictModeIgnoresIPv6OnlyOccupierBecauseServerBindsIPv4() async throws {
        // Hummingbird later binds 127.0.0.1 for the actual serve port, so
        // an IPv6-only listener on ::1:<preferred> does not actually block
        // us. Strict mode must still succeed in that case.
        let ipv6Reserved = try makeIPv6ListeningSocket(port: 0)
        defer { close(ipv6Reserved.fd) }

        let resolvedPort = try await findAvailablePort(
            startingFrom: ipv6Reserved.port,
            strict: true
        )
        XCTAssertEqual(resolvedPort, ipv6Reserved.port)
    }

    func testPreferredPortUnavailableErrorSurfacesAsHelpfulDescription() {
        let error = PortResolverError.preferredPortUnavailable(port: 5710)
        let description = error.localizedDescription
        XCTAssertTrue(description.contains("5710"), "got: \(description)")
        // Whatever the exact wording, it must not collapse to Foundation's
        // generic NSError fallback.
        XCTAssertFalse(description.contains("operation couldn"), "got: \(description)")
    }

    private func makeReservedSocket() throws -> (fd: Int32, port: Int) {
        let socket = try makeListeningSocket(port: 0)
        return socket
    }

    private func makeIPv6ListeningSocket(port: Int) throws -> (fd: Int32, port: Int) {
        let fd = socket(AF_INET6, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0)

        // Bind to ::1 only (IPv6-only) so the IPv4 loopback on the same
        // port is untouched.
        var enableV6Only: Int32 = 1
        _ = withUnsafePointer(to: &enableV6Only) {
            setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, $0, socklen_t(MemoryLayout<Int32>.size))
        }

        var address = sockaddr_in6()
        address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.stride)
        address.sin6_family = sa_family_t(AF_INET6)
        address.sin6_port = in_port_t(UInt16(port).bigEndian)
        let conversion = withUnsafeMutablePointer(to: &address.sin6_addr) {
            inet_pton(AF_INET6, "::1", $0)
        }
        XCTAssertEqual(conversion, 1)

        let bindResult = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.stride))
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
            $0.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                Int(UInt16(bigEndian: $0.pointee.sin6_port))
            }
        }
        return (fd, assignedPort)
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