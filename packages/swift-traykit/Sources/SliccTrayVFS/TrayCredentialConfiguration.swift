import Foundation






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
