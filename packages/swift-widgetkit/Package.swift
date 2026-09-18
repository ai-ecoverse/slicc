// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SliccWidgetKit",
    
    
    
    
    
    
    platforms: [.macOS(.v14), .iOS("18.0")],
    products: [
        .library(name: "SliccWidgetKit", targets: ["SliccWidgetKit"])
    ],
    targets: [
        .target(
            name: "SliccWidgetKit",
            path: "Sources/SliccWidgetKit"
        ),
        
        
        .executableTarget(
            name: "slicc-widget-gallery",
            dependencies: ["SliccWidgetKit"],
            path: "Sources/slicc-widget-gallery"
        ),
        .testTarget(
            name: "SliccWidgetKitTests",
            dependencies: ["SliccWidgetKit"],
            path: "Tests/SliccWidgetKitTests"
        ),
    ]
)
