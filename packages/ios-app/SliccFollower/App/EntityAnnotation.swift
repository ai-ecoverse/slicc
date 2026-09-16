import AppIntents
import SwiftUI

extension View {

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
