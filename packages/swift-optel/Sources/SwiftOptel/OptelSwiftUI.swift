#if canImport(SwiftUI)
import Foundation
import SwiftUI

// MARK: - View extensions

@available(iOS 16.0, macOS 13.0, *)
extension View {
    /// Root-level auto-instrumentation. Configures ``Optel`` once, fires an
    /// `enter` checkpoint on launch, re-fires `enter` whenever the scene
    /// returns to `.active` from `.background`, and installs the best-effort
    /// uncaught Objective-C exception hook.
    public func optelAutoInstrument(appID: String, rate: String? = nil) -> some View {
        modifier(OptelAutoInstrumentModifier(appID: appID, rate: rate))
    }

    /// Per-view instrumentation. Emits a `navigate` checkpoint with `source`
    /// set to `name` whenever the view appears.
    public func optelView(_ name: String) -> some View {
        modifier(OptelViewModifier(name: name))
    }

    /// Per-control click instrumentation. Attaches a `simultaneousGesture`
    /// that emits a `click` checkpoint with the supplied `source`. The
    /// underlying view's own tap handling is preserved.
    public func optelTap(source: String) -> some View {
        modifier(OptelTapModifier(source: source))
    }
}

// MARK: - Modifiers

@available(iOS 16.0, macOS 13.0, *)
public struct OptelAutoInstrumentModifier: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    let appID: String
    let rate: String?
    @State private var configured = false
    // Sticky "has been backgrounded" flag. SwiftUI scene transitions go
    // `.background → .inactive → .active`, so we cannot infer "was just
    // backgrounded" from only the immediately previous phase: `.inactive`
    // would otherwise overwrite that signal before `.active` arrives.
    @State private var wasBackgrounded = false

    public func body(content: Content) -> some View {
        content
            .task {
                guard !configured else { return }
                Optel.configure(appID: appID, rate: rate)
                OptelUncaughtExceptionHook.installIfNeeded()
                Optel.sample(.enter)
                configured = true
            }
            .onChange(of: scenePhase) { newPhase in
                let next = OptelAutoInstrumentModifier.nextState(
                    forNewPhase: newPhase,
                    wasBackgrounded: wasBackgrounded
                )
                wasBackgrounded = next.wasBackgrounded
                if next.shouldFireEnter {
                    Optel.sample(.enter)
                }
            }
    }

    /// Pure state-transition for the scene-phase tracker. Exposed for tests
    /// so the `.background → .inactive → .active` re-fire can be locked in
    /// without driving a live SwiftUI scene.
    static func nextState(
        forNewPhase newPhase: ScenePhase,
        wasBackgrounded: Bool
    ) -> (shouldFireEnter: Bool, wasBackgrounded: Bool) {
        if newPhase == .background {
            return (false, true)
        }
        if newPhase == .active && wasBackgrounded {
            return (true, false)
        }
        return (false, wasBackgrounded)
    }
}

@available(iOS 16.0, macOS 13.0, *)
public struct OptelViewModifier: ViewModifier {
    let name: String

    public func body(content: Content) -> some View {
        content.onAppear {
            Optel.sample(.navigate, source: name)
        }
    }
}

@available(iOS 16.0, macOS 13.0, *)
public struct OptelTapModifier: ViewModifier {
    let source: String

    public func body(content: Content) -> some View {
        content.simultaneousGesture(TapGesture().onEnded {
            Optel.sample(.click, source: source)
        })
    }
}

// MARK: - OptelButton

/// `Button` wrapper that emits a `click` checkpoint with a source derived from
/// the supplied accessibility identifier / label / context, then runs the
/// caller's action.
///
/// Two initializers are provided: a free-form one taking a custom label view,
/// and a convenience one mirroring `Button(_:action:)` that uses the title as
/// both the visible label and the accessibility label.
@available(iOS 16.0, macOS 13.0, *)
public struct OptelButton<Label: View>: View {
    private let identifier: String?
    private let accessibilityLabel: String?
    private let context: String?
    private let action: () -> Void
    private let labelBuilder: () -> Label

    public init(
        identifier: String? = nil,
        accessibilityLabel: String? = nil,
        context: String? = nil,
        action: @escaping () -> Void,
        @ViewBuilder label: @escaping () -> Label
    ) {
        self.identifier = identifier
        self.accessibilityLabel = accessibilityLabel
        self.context = context
        self.action = action
        self.labelBuilder = label
    }

    public var body: some View {
        Button(action: {
            let derived = OptelSourceDeriver.source(
                element: "button",
                identifier: identifier,
                label: accessibilityLabel,
                context: context
            )
            Optel.sample(.click, source: derived)
            action()
        }, label: labelBuilder)
    }
}

@available(iOS 16.0, macOS 13.0, *)
extension OptelButton where Label == Text {
    /// Convenience initializer that uses `title` as both the visible label
    /// and the derived accessibility label.
    public init(
        _ title: String,
        identifier: String? = nil,
        context: String? = nil,
        action: @escaping () -> Void
    ) {
        self.init(
            identifier: identifier,
            accessibilityLabel: title,
            context: context,
            action: action,
            label: { Text(title) }
        )
    }
}

#endif
