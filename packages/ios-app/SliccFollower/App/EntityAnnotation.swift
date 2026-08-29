import AppIntents
import SwiftUI

/// View Annotations: tell the system which app entity a given row on screen
/// is showing, so an assistant with on-screen awareness can resolve "this
/// one" / "that conversation" to a real `AppEntity` instead of guessing from
/// rendered text.
///
/// ## Why this is wrapped
///
/// `SwiftUI.View.appEntityIdentifier(_:)` exists in the iOS 26 *runtime* — the
/// symbol is right there in `SwiftUI.tbd` — but it is not public API in the
/// iOS 26 SDK, and it only became declarable in the iOS 27 SDK, where it takes
/// an `EntityIdentifier`. The repo's gating CI build uses the Xcode 26 SDK
/// (`ios-app-tests`, iOS 26 cell), so calling it unconditionally would turn
/// the merge gate red while the informational `xcode-27` cell stayed green.
///
/// `canImport(AppIntentsTypeSupport)` is the discriminator rather than
/// `compiler(>=6.4)`: that framework is new in the iOS 27 SDK, so the check
/// asks the question we actually mean ("does this SDK have the newer App
/// Intents surface?") instead of using the Swift version as a proxy for it.
///
/// Under the iOS 26 SDK this compiles away to the unmodified view — the
/// annotation is additive metadata, so losing it costs on-screen resolution
/// and nothing else. Every other leg (schemas, `IndexedEntity`, Spotlight
/// donation) is available on both SDKs and is NOT gated.
extension View {

    /// Tag this view as rendering `entityType` with identifier `id`.
    ///
    /// `id` is optional because the call sites are, too — the header renders
    /// before any unit is selected. A nil id annotates nothing rather than
    /// pointing the system at an entity that does not exist.
    @ViewBuilder
    func sliccEntityAnnotation<Entity: AppEntity>(
        _ entityType: Entity.Type,
        id: Entity.ID?
    ) -> some View {
        #if canImport(AppIntentsTypeSupport)
            if let id {
                appEntityIdentifier(EntityIdentifier(for: entityType, identifier: id))
            } else {
                self
            }
        #else
            self
        #endif
    }
}
