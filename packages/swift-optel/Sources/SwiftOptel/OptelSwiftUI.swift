#if canImport(SwiftUI)
    import Foundation
    import SwiftUI

    

    @available(iOS 16.0, macOS 13.0, *)
    extension View {
        
        
        
        
        
        
        
        
        
        
        
        
        public func optelAutoInstrument(
            appID: String,
            rate: String? = nil,
            globalHooks: Bool = true
        ) -> some View {
            modifier(
                OptelAutoInstrumentModifier(appID: appID, rate: rate, globalHooks: globalHooks)
            )
        }

        
        
        public func optelView(_ name: String) -> some View {
            modifier(OptelViewModifier(name: name))
        }

        
        
        
        public func optelTap(source: String) -> some View {
            modifier(OptelTapModifier(source: source))
        }
    }

    

    @available(iOS 16.0, macOS 13.0, *)
    public struct OptelAutoInstrumentModifier: ViewModifier {
        @Environment(\.scenePhase) private var scenePhase
        let appID: String
        let rate: String?
        let globalHooks: Bool
        @State private var configured = false
        
        
        
        
        @State private var wasBackgrounded = false

        public func body(content: Content) -> some View {
            content
                .task {
                    guard !configured else { return }
                    OptelAutoInstrumentModifier.performInstall(
                        appID: appID,
                        rate: rate,
                        globalHooks: globalHooks
                    )
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

        
        
        
        
        
        
        
        static func performInstall(
            appID: String,
            rate: String?,
            globalHooks: Bool
        ) {
            Optel.configure(appID: appID, rate: rate)
            if globalHooks {
                OptelUncaughtExceptionHook.installIfNeeded()
                #if os(macOS)
                    OptelMacAutoInstrument.installIfNeeded()
                #endif
            }
            Optel.sample(.enter)
        }
    }

    #if os(macOS)
        
        
        
        
        
        @available(macOS 13.0, *)
        public enum OptelMacAutoInstrument {
            
            public static var isInstalled: Bool {
                OptelClickMonitor.isInstalled && OptelWindowObserver.isInstalled
            }

            
            
            
            public static func installIfNeeded() {
                OptelClickMonitor.installIfNeeded()
                OptelWindowObserver.installIfNeeded()
            }

            
            public static func uninstall() {
                OptelClickMonitor.uninstall()
                OptelWindowObserver.uninstall()
            }

            
            internal static func _testing_reset() {
                OptelClickMonitor._testing_reset()
                OptelWindowObserver._testing_reset()
            }
        }
    #endif

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
            content.simultaneousGesture(
                TapGesture().onEnded {
                    OptelTapModifier.performTap(source: source)
                })
        }

        
        
        
        static func performTap(source: String) {
            OptelClickCoordinator.claimByRefined()
            Optel.sample(.click, source: source)
        }
    }

    

    
    
    
    
    
    
    
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
            Button(
                action: {
                    OptelButton<Label>.performTap(
                        identifier: identifier,
                        label: accessibilityLabel,
                        context: context
                    )
                    action()
                }, label: labelBuilder)
        }

        
        
        
        static func performTap(identifier: String?, label: String?, context: String?) {
            let derived = OptelSourceDeriver.source(
                element: "button",
                identifier: identifier,
                label: label,
                context: context
            )
            OptelClickCoordinator.claimByRefined()
            Optel.sample(.click, source: derived)
        }
    }

    @available(iOS 16.0, macOS 13.0, *)
    extension OptelButton where Label == Text {
        
        
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
