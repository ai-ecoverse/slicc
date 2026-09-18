import SwiftUI


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

    
    
    private var expression: AvatarExpressionEngine { injectedExpression ?? ownExpression }

    
    
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

    
    
    private var expressionDriven: Bool { expressive && avatar.eyes == .open }

    var body: some View {
        Group {
            if expressionDriven, !reduceMotion {
                
                
                
                
                TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
                    layers(snapshot: expression.frame(at: context.date))
                }
            } else if expressionDriven {
                
                
                
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
                    
                    
                    frozenShape: expressive ? expression.snapshot.shape : nil
                )
                .position(x: center.x, y: center.y)
            }
        }
    }

    
    
    
    
    
    
    
    
    
    
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
            
            motionDisabled: reduceMotion || pupilOffsetOverride != nil
                || (expressive && avatar.activity != .working))
        expression.configure(
            activity: avatar.activity,
            
            frozen: avatar.eyes != .open,
            reduceMotion: reduceMotion,
            blink: avatar.blink)
    }
}




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

    
    
    private var lidMask: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: avatar.lidInset(fraction: snapshot.lidTop))
            Rectangle().fill(.black)
            Color.clear.frame(height: avatar.lidInset(fraction: snapshot.lidBottom))
        }
        .frame(width: avatar.eyeDiameter, height: avatar.eyeDiameter)
    }

    
    
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















private struct ExpressiveAvatarBrows: View {
    let avatar: SliccAgentAvatarGeometry
    let snapshot: AvatarExpressionEngine.Snapshot
    let reduceMotion: Bool

    
    
    
    var body: some View {
        ZStack {
            brow(pose: snapshot.brows.left, eyeIndex: 0)
            brow(pose: snapshot.brows.right, eyeIndex: 1)
        }
        .frame(width: avatar.sideLength, height: avatar.sideLength)
    }

    
    
    
    
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
