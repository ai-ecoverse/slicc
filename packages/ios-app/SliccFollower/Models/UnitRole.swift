import Foundation
import SliccTrayKit

/// Presentation role of a work unit (#1666) — the follower's mirror of the
/// webapp's `UnitRole` in `ui/wc/wc-unit-context.ts`. Derived from the
/// ownership edge the wire carries, never from a role field of its own.
enum UnitRole: String, Equatable, Sendable {
    case cone
    case scoop
}

extension UnitRole {
    /// Users never talk to a scoop (#2312 / #2367). Selecting one opens a
    /// READ-ONLY transcript: no composer band, no send / dictation /
    /// attachment affordances and no interactive approval cards — every scoop
    /// request that needs a human is routed to the cone that owns it instead.
    ///
    /// This is the ONE place that rule is stated on the follower, the mirror
    /// of the leader's `isReadOnlyRole`. Views ask for the role of what is
    /// selected; none of them re-derives "is this a scoop".
    var isReadOnly: Bool { self == .scoop }
}

extension ScoopSummary {
    /// `true` when this summary describes a root (cone).
    ///
    /// `parentId` is the ownership edge and decides on its own wherever the
    /// leader sends it: anything owned is a scoop. `nil` covers both "this is
    /// a cone" and "this leader predates the field", so that one case falls
    /// back to the legacy `isCone` flag — and nothing else does (the flag is
    /// slated for wire removal in #2358).
    var isRootUnit: Bool { parentId == nil && isCone }

    /// The role of this unit: a root is a cone, anything owned is a scoop.
    /// The follower's half of `unitRoleFor` / `summaryRole`.
    var role: UnitRole { isRootUnit ? .cone : .scoop }

    /// Whether selecting this unit yields a read-only transcript. See
    /// ``UnitRole/isReadOnly``.
    var isReadOnly: Bool { role.isReadOnly }
}
