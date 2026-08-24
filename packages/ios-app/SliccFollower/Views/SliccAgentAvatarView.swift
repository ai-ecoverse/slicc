import SwiftUI

/// Static SwiftUI renderer for the web agent avatar's visible, tightly cropped shapes.
@MainActor
struct SliccAgentAvatarView: View {
    let avatar: SliccAgentAvatarGeometry
    private let pupilOffsetOverride: SliccAgentAvatarGeometry.Point?

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @StateObject private var tiltController: SliccAgentAvatarTiltController
    @State private var ownExpression: AvatarExpressionEngine
    private let injectedExpression: AvatarExpressionEngine?

    init(
        avatar: SliccAgentAvatarGeometry,
        tiltSource: (any SliccAgentAvatarTiltSource)? = nil,
        pupilOffset: SliccAgentAvatarGeometry.Point? = nil,
        expression: AvatarExpressionEngine? = nil
    ) {
        self.avatar = avatar
        pupilOffsetOverride = pupilOffset.map(avatar.clampedPupilOffset)
        let source = tiltSource ?? CoreMotionSliccAgentAvatarTiltSource()
        _tiltController = StateObject(
            wrappedValue: SliccAgentAvatarTiltController(source: source))
        injectedExpression = expression
        _ownExpression = State(initialValue: AvatarExpressionEngine())
    }

    /// Hosts that fire transients (`scrutinize`, `glower`, `wake`) inject their
    /// own engine; everything else gets a private one.
    private var expression: AvatarExpressionEngine { injectedExpression ?? ownExpression }

    /// The expression kit only engages when an activity is set — otherwise this
    /// is exactly the face that shipped before it.
    private var expressive: Bool { avatar.activity != nil }

    private var pupilOffset: SliccAgentAvatarGeometry.Point {
        guard !reduceMotion else { return .init(x: 0, y: 0) }
        return pupilOffsetOverride ?? tiltController.pupilOffset
    }

    private var reduceMotion: Bool {
        #if DEBUG
            systemReduceMotion || UITestHooks.reducesMotion
        #else
            systemReduceMotion
        #endif
    }

    private var agentColor: Color {
        guard let parsed = Color(hexToken: avatar.color) else {
            return avatar.type == .cone
                ? Color(red: 0.824, green: 0.412, blue: 0.118)
                : Color(red: 1, green: 0.714, blue: 0.757)
        }
        return parsed
    }

    /// The only case with a snapshot to paint — and so the only one that grows
    /// brows: the expression kit driving eyes that are actually open.
    private var expressionDriven: Bool { expressive && avatar.eyes == .open }

    var body: some View {
        Group {
            if expressionDriven, !reduceMotion {
                // ONE timeline for the whole avatar. The tile and the brow
                // layer over it must paint the same frame, and the engine
                // integrates on every read — a second timeline would step it
                // twice per frame.
                TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
                    layers(snapshot: expression.frame(at: context.date))
                }
            } else if expressionDriven {
                // Reduced motion renders ONE settled frame — no timeline, no
                // blinks, no saccades — which is also what the screenshot
                // fixtures capture.
                layers(snapshot: expression.snapshot)
            } else {
                layers(snapshot: nil)
            }
        }
        .frame(width: avatar.sideLength, height: avatar.sideLength)
        .accessibilityHidden(true)
        .onAppear { synchronize() }
        .onDisappear { tiltController.stopAndCenter() }
        .onChange(of: reduceMotion) { _, _ in synchronize() }
        .onChange(of: avatar) { _, _ in synchronize() }
    }

    /// The two layers, mirroring the web's `.crop` + `.brow-layer` split.
    ///
    /// **Only the tile is cropped.** The roundrect used to clip the entire
    /// avatar, which is why the brows had to be squeezed into the headroom
    /// above the eyes to survive it. Now the tint, glyph, sockets, pupils and
    /// lids still clip at the tile and the brows paint OVER it in band space,
    /// so they overhang — sideways and at the top, ~3pt at the 26pt rail size.
    /// Hosts must therefore not clip an avatar; the chat header's 36pt box
    /// around a 30pt tile is the slack that buys.
    private func layers(snapshot: AvatarExpressionEngine.Snapshot?) -> some View {
        ZStack {
            tile(snapshot: snapshot)
                .frame(width: avatar.sideLength, height: avatar.sideLength)
                .clipShape(RoundedRectangle(cornerRadius: avatar.tileCornerRadius))
            if let snapshot {
                ExpressiveAvatarBrows(
                    avatar: avatar, snapshot: snapshot, reduceMotion: reduceMotion)
            }
        }
    }

    /// Everything the roundrect crops.
    private func tile(snapshot: AvatarExpressionEngine.Snapshot?) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: avatar.tileCornerRadius)
                .fill(agentColor.opacity(0.18))
            Ellipse()
                .fill(agentColor)
                .frame(width: avatar.glyphSize.x, height: avatar.glyphSize.y)
                .position(x: avatar.glyphCenter.x, y: avatar.glyphCenter.y)
            eyes(snapshot: snapshot)
        }
    }

    @ViewBuilder
    private func eyes(snapshot: AvatarExpressionEngine.Snapshot?) -> some View {
        switch avatar.eyes {
        case .open:
            if let snapshot {
                expressionEyes(snapshot: snapshot)
            } else {
                ForEach(Array(avatar.eyeCenters.enumerated()), id: \.offset) { index, center in
                    BlinkingAvatarEye(
                        avatar: avatar,
                        pupilOffset: pupilOffset,
                        duration: index == 0 ? 3.4 : 4.6,
                        enabled: avatar.blink && !reduceMotion
                    )
                    .position(x: center.x, y: center.y)
                }
            }
        case .dead:
            ForEach(Array(avatar.eyeCenters.enumerated()), id: \.offset) { _, center in
                DeadAvatarEye(avatar: avatar)
                    .position(x: center.x, y: center.y)
            }
        case .none:
            EmptyView()
        case .static:
            ForEach(Array(avatar.eyeCenters.enumerated()), id: \.offset) { index, center in
                StaticAvatarEye(
                    avatar: avatar,
                    eyeIndex: index,
                    reduceMotion: reduceMotion,
                    // Static freezes the shape at its last committed value
                    // rather than snapping back to a circle.
                    frozenShape: expressive ? expression.snapshot.shape : nil
                )
                .position(x: center.x, y: center.y)
            }
        }
    }

    /// Both eyes overlay the WHOLE tile: `.position` reads its coordinates from
    /// the parent's space, so the pair has to share one container that measures
    /// `sideLength` on both axes. The explicit `ZStack` is what guarantees that.
    /// Handed to `TimelineView` bare, the two eyes are its multi-view content
    /// and get stacked vertically instead — each one laid out in half the tile,
    /// which drops the right eye a half tile below the left and clips it to the
    /// bottom-right corner. That only bit the animating path (the settled
    /// reduced-motion frame the screenshot fixtures capture went straight into
    /// this view's own ZStack), which is why the live header disagreed with the
    /// fixtures.
    private func expressionEyes(
        snapshot: AvatarExpressionEngine.Snapshot
    ) -> some View {
        ZStack {
            ForEach(Array(avatar.eyeCenters.enumerated()), id: \.offset) { index, center in
                ExpressiveAvatarEye(
                    avatar: avatar,
                    snapshot: snapshot,
                    eyeIndex: index,
                    pupilOffset: expressionPupilOffset(snapshot: snapshot, eyeIndex: index)
                )
                .position(x: center.x, y: center.y)
            }
        }
        .frame(width: avatar.sideLength, height: avatar.sideLength)
    }

    /// While a tool runs, CoreMotion tilt owns the gaze — the web's pointer
    /// channel. Every other activity is self-directed, so the engine owns it.
    private func expressionPupilOffset(
        snapshot: AvatarExpressionEngine.Snapshot, eyeIndex: Int
    ) -> SliccAgentAvatarGeometry.Point {
        guard avatar.activity != .working else { return pupilOffset }
        guard !reduceMotion else { return .init(x: 0, y: 0) }
        let offset = eyeIndex == 0 ? snapshot.leftPupilOffset : snapshot.rightPupilOffset
        let scale = avatar.expressionScale
        return .init(x: offset.x * scale, y: offset.y * scale)
    }

    private func synchronize() {
        tiltController.update(
            geometry: avatar,
            // The engine owns the pupils unless a tool call is running.
            motionDisabled: reduceMotion || pupilOffsetOverride != nil
                || (expressive && avatar.activity != .working))
        expression.configure(
            activity: avatar.activity,
            // Static outranks every expression channel and freezes it.
            frozen: avatar.eyes != .open,
            reduceMotion: reduceMotion,
            blink: avatar.blink)
    }
}

/// One eye wearing the expression kit: the socket morph as a corner radius,
/// and chord-cut lids as a rectangular mask plus a closing line. The brow is
/// NOT here — it paints outside the tile crop, in `ExpressiveAvatarBrows`.
private struct ExpressiveAvatarEye: View {
    let avatar: SliccAgentAvatarGeometry
    let snapshot: AvatarExpressionEngine.Snapshot
    let eyeIndex: Int
    let pupilOffset: SliccAgentAvatarGeometry.Point

    var body: some View {
        ZStack {
            socket.mask(lidMask)
            chord(edge: .top)
            chord(edge: .bottom)
        }
        .frame(width: avatar.eyeDiameter, height: avatar.eyeDiameter)
        .scaleEffect(y: snapshot.blinkScale)
    }

    /// A rounded rect whose corner radius IS the shape channel: at rx = half
    /// the side it renders as the circle the avatar has always had.
    private var socket: some View {
        let radius = avatar.socketCornerRadius(shape: snapshot.shape)
        return ZStack {
            RoundedRectangle(cornerRadius: radius).fill(.white)
            RoundedRectangle(cornerRadius: radius)
                .stroke(.black, lineWidth: avatar.eyeOutlineWidth)
            pupil
        }
        .frame(width: avatar.eyeDiameter, height: avatar.eyeDiameter)
    }

    private var pupil: some View {
        let radius = avatar.pupilRadius * snapshot.pupilScale
        let corner = avatar.pupilCornerRadius(shape: snapshot.shape, radius: radius)
        return ZStack {
            RoundedRectangle(cornerRadius: corner)
                .fill(.black)
                .frame(width: radius * 2, height: radius * 2)
            Circle()
                .fill(.white)
                .frame(width: radius * 0.8, height: radius * 0.8)
                .offset(x: -0.3 * radius, y: -0.35 * radius)
        }
        .offset(x: pupilOffset.x, y: pupilOffset.y)
    }

    /// The lid: one rectangular mask offset per edge — the SwiftUI mirror of
    /// the web's clip rect.
    private var lidMask: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: avatar.lidInset(fraction: snapshot.lidTop))
            Rectangle().fill(.black)
            Color.clear.frame(height: avatar.lidInset(fraction: snapshot.lidBottom))
        }
        .frame(width: avatar.eyeDiameter, height: avatar.eyeDiameter)
    }

    /// The straight line that closes the socket outline at a lid cut. Its width
    /// tracks the socket's corner radius, so it stays flush as the eye squares.
    private func chord(edge: SliccAgentAvatarGeometry.LidEdge) -> some View {
        let fraction = edge == .top ? snapshot.lidTop : snapshot.lidBottom
        let inset = avatar.lidInset(fraction: fraction)
        let half = avatar.chordHalfWidth(fraction: fraction, shape: snapshot.shape, edge: edge)
        return Capsule()
            .fill(.black)
            .frame(width: half * 2, height: avatar.eyeOutlineWidth)
            .position(
                x: avatar.eyeDiameter / 2,
                y: edge == .top ? inset : avatar.eyeDiameter - inset
            )
            .opacity(fraction > AvatarExpression.lidLineEpsilon ? 1 : 0)
    }
}

/// The brows: two capsules painted OUTSIDE the tile's roundrect, the SwiftUI
/// mirror of the web's `.brow-layer`.
///
/// Placement is plain band space — centred over its eye at `browY`, raise in
/// band units — because nothing crops them any more. The old mapping pulled
/// each brow inward by `0.9 * browHalfWidth` and budgeted rest and lift out of
/// the ~14pt of headroom above the eye, which was the only way to keep a brow
/// inside a tile that clipped everything. Both hacks are gone with the clip.
///
/// They also sit outside `ExpressiveAvatarEye` deliberately: its lid squash
/// (`blinkScale`) used to fold the brows flat onto the eyeball. The crop hid
/// that; uncropped it reads as a wince twice every few seconds. A blink is a
/// lid move, so the brows hold their pose across it — which is what turns the
/// apex re-cock into a visible transition instead of a swap under the squash.
private struct ExpressiveAvatarBrows: View {
    let avatar: SliccAgentAvatarGeometry
    let snapshot: AvatarExpressionEngine.Snapshot
    let reduceMotion: Bool

    /// One container measuring the whole tile, for the same reason
    /// `expressionEyes` needs one: `.position` reads the parent's coordinate
    /// space, and a bare pair would be laid out as stacked halves.
    var body: some View {
        ZStack {
            brow(pose: snapshot.brows.left, eyeIndex: 0)
            brow(pose: snapshot.brows.right, eyeIndex: 1)
        }
        .frame(width: avatar.sideLength, height: avatar.sideLength)
    }

    /// Two scalars, one capsule: raise lifts it off the eye, tilt cocks it.
    /// Pose changes ease over `browTransitionSeconds` — the web's
    /// `transition: transform` — and, like the web's reduced-motion rule, snap
    /// when motion is reduced.
    private func brow(pose: AvatarExpression.BrowPose, eyeIndex: Int) -> some View {
        let center = avatar.browCenter(eyeIndex: eyeIndex, raise: pose.raise)
        let transition: Animation? =
            reduceMotion ? nil : .easeInOut(duration: AvatarExpression.browTransitionSeconds)
        return Capsule()
            .fill(.black)
            .frame(width: avatar.browSize.x, height: avatar.browSize.y)
            .rotationEffect(.degrees(pose.tilt))
            .position(x: center.x, y: center.y)
            .opacity(snapshot.browsVisible ? 1 : 0)
            .animation(transition, value: pose)
            .animation(transition, value: snapshot.browsVisible)
    }
}

private struct EyeSurface: View {
    let avatar: SliccAgentAvatarGeometry

    var body: some View {
        ZStack {
            Ellipse().fill(.white)
            Ellipse().stroke(.black, lineWidth: avatar.eyeOutlineWidth)
        }
        .frame(width: avatar.eyeDiameter, height: avatar.eyeDiameter)
    }
}

private struct BlinkingAvatarEye: View {
    let avatar: SliccAgentAvatarGeometry
    let pupilOffset: SliccAgentAvatarGeometry.Point
    let duration: TimeInterval
    let enabled: Bool

    @State private var cycleStart = Date()

    var body: some View {
        Group {
            if enabled {
                TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
                    eye.scaleEffect(y: blinkScale(at: context.date))
                }
            } else {
                eye
            }
        }
        .frame(width: avatar.eyeDiameter, height: avatar.eyeDiameter)
    }

    private var eye: some View {
        ZStack {
            EyeSurface(avatar: avatar)
            ZStack {
                Ellipse()
                    .fill(.black)
                    .frame(width: avatar.pupilRadius * 2, height: avatar.pupilRadius * 2)
                Circle()
                    .fill(.white)
                    .frame(width: avatar.highlightRadius * 2, height: avatar.highlightRadius * 2)
                    .offset(x: avatar.highlightOffset.x, y: avatar.highlightOffset.y)
            }
            .offset(x: pupilOffset.x, y: pupilOffset.y)
        }
    }

    private func blinkScale(at date: Date) -> Double {
        let phase = date.timeIntervalSince(cycleStart).truncatingRemainder(dividingBy: duration) / duration
        if phase < 0.92 { return 1 }
        if phase <= 0.96 { return 1 - 0.92 * eased((phase - 0.92) / 0.04) }
        return 0.08 + 0.92 * eased((phase - 0.96) / 0.04)
    }

    private func eased(_ progress: Double) -> Double {
        progress * progress * (3 - 2 * progress)
    }
}

private struct DeadAvatarEye: View {
    let avatar: SliccAgentAvatarGeometry

    var body: some View {
        ZStack {
            EyeSurface(avatar: avatar)
            cross.rotationEffect(.degrees(45))
            cross.rotationEffect(.degrees(-45))
        }
        .frame(width: avatar.eyeDiameter, height: avatar.eyeDiameter)
    }

    private var cross: some View {
        Capsule()
            .fill(.black)
            .frame(width: avatar.deadCrossHalfSpan * 2.8, height: avatar.deadCrossLineWidth)
    }
}

private struct StaticAvatarEye: View {
    let avatar: SliccAgentAvatarGeometry
    let eyeIndex: Int
    let reduceMotion: Bool
    /// Non-nil once the expression kit is engaged: the socket keeps the corner
    /// radius it froze at instead of reverting to a circle.
    var frozenShape: Double?

    var body: some View {
        Group {
            if reduceMotion {
                eye(seed: frozenSeed)
            } else {
                TimelineView(
                    .periodic(
                        from: .now,
                        by: 1.0 / SliccAgentAvatarGeometry.noiseFramesPerSecond)
                ) { context in
                    eye(seed: animatedSeed(at: context.date))
                }
            }
        }
        .frame(width: avatar.eyeDiameter, height: avatar.eyeDiameter)
    }

    private var frozenSeed: UInt32 {
        SliccAgentAvatarGeometry.frozenNoiseSeed
            ^ (UInt32(truncatingIfNeeded: eyeIndex) &* SliccAgentAvatarGeometry.noiseEyeSalt)
    }

    private func animatedSeed(at date: Date) -> UInt32 {
        let frame = UInt32(
            truncatingIfNeeded: Int64(
                floor(
                    date.timeIntervalSinceReferenceDate
                        * SliccAgentAvatarGeometry.noiseFramesPerSecond)))
        return frozenSeed ^ (frame &* SliccAgentAvatarGeometry.noiseFrameSalt)
    }

    @ViewBuilder
    private func eye(seed: UInt32) -> some View {
        if let frozenShape {
            let socket = RoundedRectangle(
                cornerRadius: avatar.socketCornerRadius(shape: frozenShape))
            ZStack {
                socket.fill(.white)
                AvatarStaticNoise(seed: seed).clipShape(socket)
                socket.stroke(.black, lineWidth: avatar.eyeOutlineWidth)
            }
        } else {
            ZStack {
                Ellipse().fill(.white)
                AvatarStaticNoise(seed: seed)
                    .clipShape(Ellipse())
                Ellipse().stroke(.black, lineWidth: avatar.eyeOutlineWidth)
            }
        }
    }
}

private struct AvatarStaticNoise: View {
    let seed: UInt32

    var body: some View {
        Canvas { context, size in
            let cellSize = SliccAgentAvatarGeometry.noiseCellSize
            var noise = AvatarNoiseGenerator(seed: seed)
            for y in stride(from: 0.0, to: size.height, by: cellSize) {
                for x in stride(from: 0.0, to: size.width, by: cellSize) {
                    let shade = SliccAgentAvatarGeometry.noiseLuminance[
                        Int(noise.next() % UInt32(SliccAgentAvatarGeometry.noiseLuminance.count))
                    ]
                    let rect = CGRect(
                        x: x,
                        y: y,
                        width: min(cellSize, size.width - x),
                        height: min(cellSize, size.height - y))
                    context.fill(
                        Path(rect),
                        with: .color(
                            Color(white: shade)
                                .opacity(SliccAgentAvatarGeometry.noiseOpacity)))
                }
            }
        }
    }
}

struct AvatarNoiseGenerator {
    private var state: UInt32

    init(seed: UInt32) {
        state = seed == 0 ? SliccAgentAvatarGeometry.frozenNoiseSeed : seed
    }

    mutating func next() -> UInt32 {
        state ^= state << 13
        state ^= state >> 17
        state ^= state << 5
        return state
    }
}

#Preview("Avatar state matrix") {
    HStack(spacing: 24) {
        AvatarPreviewColumn(scheme: .light)
        AvatarPreviewColumn(scheme: .dark)
    }
    .padding()
}

private struct AvatarPreviewColumn: View {
    let scheme: ColorScheme

    private let states = [
        SliccAgentAvatarGeometry(type: .scoop, color: "#8B5CF6", fill: 76, blink: true, sideLength: 72),
        SliccAgentAvatarGeometry(type: .cone, color: "#F59E0B", fill: 32, sideLength: 72),
        SliccAgentAvatarGeometry(type: .scoop, color: "#F97316", eyes: .dead, fill: 84, sideLength: 72),
        SliccAgentAvatarGeometry(type: .scoop, color: "#38BDF8", eyes: .none, fill: 14, sideLength: 72),
        SliccAgentAvatarGeometry(type: .cone, color: "#F59E0B", eyes: .static, fill: 92, sideLength: 72),
    ]

    var body: some View {
        VStack(spacing: 12) {
            ForEach(Array(states.enumerated()), id: \.offset) { _, state in
                SliccAgentAvatarView(avatar: state)
            }
        }
        .padding()
        .background(scheme == .dark ? Color.black : Color.white)
        .environment(\.colorScheme, scheme)
    }
}
