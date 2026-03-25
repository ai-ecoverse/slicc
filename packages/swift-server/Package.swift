// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SliccServer",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird", from: "2.21.1"),
        .package(url: "https://github.com/hummingbird-project/hummingbird-websocket", from: "2.0.0"),
        .package(url: "https://github.com/swift-server/async-http-client", from: "1.21.0"),
        .package(url: "https://github.com/vapor/websocket-kit", from: "2.15.0"),
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.3.0"),
        .package(url: "https://github.com/apple/swift-log", from: "1.10.1"),
    ],
    targets: [
        .executableTarget(
            name: "slicc-server",
            dependencies: [
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdWebSocket", package: "hummingbird-websocket"),
                .product(name: "AsyncHTTPClient", package: "async-http-client"),
                .product(name: "WebSocketKit", package: "websocket-kit"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "Logging", package: "swift-log"),
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "slicc-serverTests",
            dependencies: [
                "slicc-server",
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdTesting", package: "hummingbird"),
                .product(name: "AsyncHTTPClient", package: "async-http-client"),
            ],
            path: "Tests"
        ),
    ]
)