// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SliccServer",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird", from: "2.26.0"),
        .package(url: "https://github.com/hummingbird-project/hummingbird-websocket", from: "2.7.0"),
        .package(url: "https://github.com/swift-server/async-http-client", from: "1.36.0"),
        .package(url: "https://github.com/vapor/websocket-kit", from: "2.16.2"),
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.8.2"),
        .package(url: "https://github.com/apple/swift-log", from: "1.14.0"),
        // Headless tray-follower transport (WebRTC + signalling + tray-sync
        // protocol) shared with the iOS app so the WebRTC framework and the
        // transport core are not double-shipped. Only `SliccTrayFollower`
        // (WebRTC-bearing) is consumed here; `SliccTraySession` (Foundation-only,
        // used by swift-launcher) is a separate product and is NOT pulled in.
        .package(path: "../swift-traysession"),
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
                .product(name: "SliccTrayFollower", package: "swift-traysession"),
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
                .product(name: "SliccTrayFollower", package: "swift-traysession"),
            ],
            path: "Tests"
        ),
    ]
)
