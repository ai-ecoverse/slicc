import Foundation

/// Platform-specific app-group and keychain identifiers for the File Provider
/// credential store. macOS 15+ authorizes team-prefixed groups by signature alone;
/// iOS uses the follower app-group the appex already declares.
public enum TrayCredentialConfiguration {
    public static var appGroupIdentifier: String {
        #if os(macOS)
            return "S8LB56P782.com.slicc.sliccstart.fileprovider"
        #else
            return "group.ai.sliccy.follower"
        #endif
    }

    public static var keychainAccessGroup: String {
        #if os(macOS)
            return "S8LB56P782.com.slicc.sliccstart.fileprovider.credentials"
        #else
            return "S8LB56P782.ai.sliccy.follower.credentials"
        #endif
    }

    public static var fileProviderRuntime: String {
        #if os(macOS)
            return "slicc-macos-file-provider"
        #else
            return "slicc-ios-file-provider"
        #endif
    }
}
