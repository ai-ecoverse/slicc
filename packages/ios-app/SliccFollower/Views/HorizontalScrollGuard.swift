import Combine
import SwiftUI

/// Resolves transcript touch-down locations against guarded horizontal scrollers.
final class HorizontalScrollGestureState: ObservableObject {
    let coordinateSpaceName = UUID()
    fileprivate static let horizontalTouchSlop: CGFloat = 8

    private struct Region {
        let frame: CGRect
        let context: SwipeArbiter.ScrollContext?
    }

    private var regions: [UUID: Region] = [:]
    private var innerContext: SwipeArbiter.ScrollContext?
    private var capturedOrigin: SwipeArbiter.DragOrigin?
    private var outerGestureActive = false
    private var touchActive = false

    func beginInnerGesture(context: SwipeArbiter.ScrollContext) {
        innerContext = context
        guard outerGestureActive else { return }
        if case .some(.guardedContent) = capturedOrigin { return }
        capturedOrigin = .guardedContent(context)
    }

    func endInnerGesture() {
        innerContext = nil
    }

    func updateRegion(
        id: UUID,
        frame: CGRect,
        context: SwipeArbiter.ScrollContext?
    ) {
        guard !frame.isNull, frame.width > 0, frame.height > 0 else {
            regions[id] = nil
            return
        }
        regions[id] = Region(frame: frame, context: context)
    }

    func removeRegion(id: UUID) {
        regions[id] = nil
    }

    func dragOrigin(at location: CGPoint) -> SwipeArbiter.DragOrigin {
        let region = regions.values
            .filter {
                $0.frame.insetBy(dx: -Self.horizontalTouchSlop, dy: 0).contains(location)
            }
            .min { area(of: $0.frame) < area(of: $1.frame) }
        guard let region else { return .ordinaryContent }
        guard let context = region.context else { return .unknown }
        return .guardedContent(context)
    }

    func beginOuterGesture(at startLocation: CGPoint) {
        guard !touchActive else { return }
        touchActive = true
        outerGestureActive = true
        capturedOrigin =
            innerContext.map(SwipeArbiter.DragOrigin.guardedContent)
            ?? dragOrigin(at: startLocation)
    }

    func endTouchGesture() {
        touchActive = false
    }

    func endOuterGesture() -> SwipeArbiter.DragOrigin {
        defer {
            outerGestureActive = false
            touchActive = false
            capturedOrigin = nil
        }
        return capturedOrigin ?? .unknown
    }

    private func area(of frame: CGRect) -> CGFloat {
        frame.width * frame.height
    }
}

private struct HorizontalScrollRegionFrameKey: PreferenceKey {
    static let defaultValue = CGRect.null

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if !next.isNull {
            value = next
        }
    }
}

private struct HorizontalScrollGestureStateKey: EnvironmentKey {
    static let defaultValue = HorizontalScrollGestureState()
}

private struct HorizontalScrollActionKey: EnvironmentKey {
    static let defaultValue: (SwipeArbiter.Action) -> Void = { _ in }
}

extension EnvironmentValues {
    var horizontalScrollGestureState: HorizontalScrollGestureState {
        get { self[HorizontalScrollGestureStateKey.self] }
        set { self[HorizontalScrollGestureStateKey.self] = newValue }
    }

    var horizontalScrollAction: (SwipeArbiter.Action) -> Void {
        get { self[HorizontalScrollActionKey.self] }
        set { self[HorizontalScrollActionKey.self] = newValue }
    }
}

private struct HorizontalScrollMetrics: Equatable {
    var contentWidth: CGFloat = 0
    var offset: CGFloat = 0
}

private struct HorizontalScrollMetricsKey: PreferenceKey {
    static let defaultValue = HorizontalScrollMetrics()

    static func reduce(
        value: inout HorizontalScrollMetrics,
        nextValue: () -> HorizontalScrollMetrics
    ) {
        value = nextValue()
    }
}

private struct HorizontalScrollViewportWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct HorizontalScrollGuardModifier: ViewModifier {
    let showsIndicators: Bool

    @Environment(\.horizontalScrollGestureState) private var gestureState
    @Environment(\.horizontalScrollAction) private var horizontalScrollAction
    @State private var scrollCoordinateSpaceName = UUID()
    @State private var regionID = UUID()
    @State private var metrics = HorizontalScrollMetrics()
    @State private var viewportWidth: CGFloat = 0
    @State private var regionFrame = CGRect.null
    @State private var touchActive = false
    @State private var capturedOrigin: SwipeArbiter.DragOrigin?

    func body(content: Content) -> some View {
        ScrollView(.horizontal, showsIndicators: showsIndicators) {
            content.background {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: HorizontalScrollMetricsKey.self,
                        value: HorizontalScrollMetrics(
                            contentWidth: proxy.size.width,
                            offset: -proxy.frame(in: .named(scrollCoordinateSpaceName)).minX
                        ))
                }
            }
        }
        .coordinateSpace(name: scrollCoordinateSpaceName)
        .padding(.horizontal, -HorizontalScrollGestureState.horizontalTouchSlop)
        .background {
            GeometryReader { proxy in
                Color.clear
                    .preference(
                        key: HorizontalScrollViewportWidthKey.self,
                        value: proxy.size.width
                    )
                    .preference(
                        key: HorizontalScrollRegionFrameKey.self,
                        value: proxy.frame(in: .named(gestureState.coordinateSpaceName))
                    )
            }
        }
        .onPreferenceChange(HorizontalScrollMetricsKey.self) { newMetrics in
            metrics = newMetrics
            publishRegion(metrics: newMetrics, viewportWidth: viewportWidth, frame: regionFrame)
        }
        .onPreferenceChange(HorizontalScrollViewportWidthKey.self) { newWidth in
            viewportWidth = newWidth
            publishRegion(metrics: metrics, viewportWidth: newWidth, frame: regionFrame)
        }
        .onPreferenceChange(HorizontalScrollRegionFrameKey.self) { newFrame in
            regionFrame = newFrame
            publishRegion(metrics: metrics, viewportWidth: viewportWidth, frame: newFrame)
        }
        .simultaneousGesture(touchDownGesture)
        .onDisappear { gestureState.removeRegion(id: regionID) }
    }

    private var touchDownGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { _ in
                guard !touchActive else { return }
                touchActive = true
                let context = SwipeArbiter.ScrollContext(
                    offset: metrics.offset,
                    contentWidth: metrics.contentWidth,
                    viewportWidth: effectiveViewportWidth(viewportWidth))
                capturedOrigin = .guardedContent(context)
                gestureState.beginInnerGesture(context: context)
            }
            .onEnded { value in
                let origin = capturedOrigin ?? .unknown
                touchActive = false
                capturedOrigin = nil
                gestureState.endInnerGesture()
                horizontalScrollAction(
                    SwipeArbiter.action(for: value.translation, origin: origin))
            }
    }

    private func publishRegion(
        metrics: HorizontalScrollMetrics,
        viewportWidth: CGFloat,
        frame: CGRect
    ) {
        let context: SwipeArbiter.ScrollContext? =
            if metrics.contentWidth > 0, viewportWidth > 0 {
                SwipeArbiter.ScrollContext(
                    offset: metrics.offset,
                    contentWidth: metrics.contentWidth,
                    viewportWidth: effectiveViewportWidth(viewportWidth))
            } else {
                nil
            }
        gestureState.updateRegion(id: regionID, frame: frame, context: context)
    }

    private func effectiveViewportWidth(_ measuredWidth: CGFloat) -> CGFloat {
        measuredWidth + HorizontalScrollGestureState.horizontalTouchSlop * 2
    }
}

extension View {
    /// Wraps content in an iOS 17 horizontal scroller that arbitrates parent swipes.
    func horizontalScrollGuard(showsIndicators: Bool = true) -> some View {
        modifier(HorizontalScrollGuardModifier(showsIndicators: showsIndicators))
    }
}
