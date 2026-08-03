import SwiftUI

/// Static SwiftUI renderer for the web agent avatar's visible, tightly cropped shapes.
struct SliccAgentAvatarView: View {
    let avatar: SliccAgentAvatarGeometry

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var agentColor: Color {
        guard let parsed = Color(hexToken: avatar.color) else {
            return avatar.type == .cone
                ? Color(red: 0.824, green: 0.412, blue: 0.118)
                : Color(red: 1, green: 0.714, blue: 0.757)
        }
        return parsed
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: avatar.tileCornerRadius)
                .fill(agentColor.opacity(0.18))
            Ellipse()
                .fill(agentColor)
                .frame(width: avatar.glyphSize.x, height: avatar.glyphSize.y)
                .position(x: avatar.glyphCenter.x, y: avatar.glyphCenter.y)
            eyes
        }
        .frame(width: avatar.sideLength, height: avatar.sideLength)
        .clipShape(RoundedRectangle(cornerRadius: avatar.tileCornerRadius))
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var eyes: some View {
        switch avatar.eyes {
        case .open:
            ForEach(Array(avatar.eyeCenters.enumerated()), id: \.offset) { index, center in
                BlinkingAvatarEye(
                    avatar: avatar,
                    duration: index == 0 ? 3.4 : 4.6,
                    enabled: avatar.blink && !reduceMotion
                )
                .position(x: center.x, y: center.y)
            }
        case .dead:
            ForEach(Array(avatar.eyeCenters.enumerated()), id: \.offset) { _, center in
                DeadAvatarEye(avatar: avatar)
                    .position(x: center.x, y: center.y)
            }
        case .none:
            EmptyView()
        }
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
            Ellipse()
                .fill(.black)
                .frame(width: avatar.pupilRadius * 2, height: avatar.pupilRadius * 2)
            Circle()
                .fill(.white)
                .frame(width: avatar.highlightRadius * 2, height: avatar.highlightRadius * 2)
                .offset(x: avatar.highlightOffset.x, y: avatar.highlightOffset.y)
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
