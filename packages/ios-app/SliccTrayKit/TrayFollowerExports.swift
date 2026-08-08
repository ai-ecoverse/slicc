// The tray-follower transport core (signalling, WebRTC, tray-sync protocol
// mirror, chunk framing) moved OUT of SliccTrayKit into the shared
// `SliccTrayFollower` module in `packages/swift-traysession`, so swift-server
// and this app share one copy instead of double-shipping it.
//
// Re-export it so every SliccTrayKit source file — and everything that
// `import SliccTrayKit` (the app target, the File Provider appex, the tests) —
// keeps seeing those public types unqualified, exactly as when they lived here.
// Tests that reach an *internal* member of a moved type still need their own
// `@testable import SliccTrayFollower` (see TraySupersedeTests, ChunkFramingTests).
@_exported import SliccTrayFollower
