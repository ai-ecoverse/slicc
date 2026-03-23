import Darwin
import Foundation

enum PortResolverError: Error, Sendable {
    case invalidPort(Int)
    case noAvailablePorts(startingFrom: Int)
    case socketFailure(code: Int32, host: String, port: Int)
}

/// Try to bind a TCP socket to the port. If it fails, increment and retry.
/// Returns the first available port starting from `preferred`.
func findAvailablePort(startingFrom preferred: Int) async throws -> Int {
    guard (0...65_535).contains(preferred) else {
        throw PortResolverError.invalidPort(preferred)
    }

    if preferred == 0 {
        return try tryListenOnPortDualStack(0)
    }

    var port = preferred
    while port <= 65_535 {
        do {
            return try tryListenOnPortDualStack(port)
        } catch let error as PortResolverError {
            switch error {
            case .socketFailure(let code, _, _) where code == EADDRINUSE:
                port += 1
            default:
                throw error
            }
        }
    }

    throw PortResolverError.noAvailablePorts(startingFrom: preferred)
}

private enum LoopbackAddress {
    case ipv4
    case ipv6

    var host: String {
        switch self {
        case .ipv4: return "127.0.0.1"
        case .ipv6: return "::1"
        }
    }

    var family: Int32 {
        switch self {
        case .ipv4: return AF_INET
        case .ipv6: return AF_INET6
        }
    }
}

private func tryListenOnPortDualStack(_ port: Int) throws -> Int {
    let assignedPort = try tryListenOnPort(port, host: .ipv4)
    do {
        _ = try tryListenOnPort(assignedPort, host: .ipv6)
    } catch let error as PortResolverError {
        if case .socketFailure(let code, _, _) = error, code == EADDRINUSE {
            throw error
        }
        // Ignore IPv6 availability issues, mirroring the Node implementation.
    }
    return assignedPort
}

private func tryListenOnPort(_ port: Int, host: LoopbackAddress) throws -> Int {
    let fd = socket(host.family, SOCK_STREAM, 0)
    guard fd >= 0 else {
        throw socketFailure(host: host.host, port: port)
    }
    defer { _ = close(fd) }

    if host.family == AF_INET6 {
        var enableV6Only: Int32 = 1
        _ = withUnsafePointer(to: &enableV6Only) {
            setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, $0, socklen_t(MemoryLayout<Int32>.size))
        }
    }

    switch host {
    case .ipv4:
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.stride)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        let conversion = withUnsafeMutablePointer(to: &address.sin_addr) {
            inet_pton(AF_INET, host.host, $0)
        }
        guard conversion == 1 else {
            throw socketFailure(host: host.host, port: port)
        }
        let bindResult = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.stride))
            }
        }
        guard bindResult == 0 else {
            throw socketFailure(host: host.host, port: port)
        }
    case .ipv6:
        var address = sockaddr_in6()
        address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.stride)
        address.sin6_family = sa_family_t(AF_INET6)
        address.sin6_port = in_port_t(UInt16(port).bigEndian)
        let conversion = withUnsafeMutablePointer(to: &address.sin6_addr) {
            inet_pton(AF_INET6, host.host, $0)
        }
        guard conversion == 1 else {
            throw socketFailure(host: host.host, port: port)
        }
        let bindResult = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.stride))
            }
        }
        guard bindResult == 0 else {
            throw socketFailure(host: host.host, port: port)
        }
    }

    guard Darwin.listen(fd, 1) == 0 else {
        throw socketFailure(host: host.host, port: port)
    }

    return try currentPort(for: fd)
}

private func currentPort(for fileDescriptor: Int32) throws -> Int {
    var storage = sockaddr_storage()
    var length = socklen_t(MemoryLayout<sockaddr_storage>.stride)
    let result = withUnsafeMutablePointer(to: &storage) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(fileDescriptor, $0, &length)
        }
    }
    guard result == 0 else {
        throw socketFailure(host: "<bound>", port: 0)
    }

    switch Int32(storage.ss_family) {
    case AF_INET:
        return withUnsafePointer(to: &storage) {
            $0.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                Int(UInt16(bigEndian: $0.pointee.sin_port))
            }
        }
    case AF_INET6:
        return withUnsafePointer(to: &storage) {
            $0.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                Int(UInt16(bigEndian: $0.pointee.sin6_port))
            }
        }
    default:
        throw socketFailure(host: "<bound>", port: 0)
    }
}

private func socketFailure(host: String, port: Int) -> PortResolverError {
    PortResolverError.socketFailure(code: errno, host: host, port: port)
}