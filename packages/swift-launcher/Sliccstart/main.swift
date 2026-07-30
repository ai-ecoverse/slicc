import Foundation

// Headless `Sliccstart --list-sessions [--reveal-urls]` short-circuits before
// the SwiftUI app boots so the `slicc` CLI can read iCloud tray sessions from
// the signed, iCloud-entitled launcher binary. Any other launch falls through
// to the normal GUI app.
if let request = TraySessionCLI.parse(CommandLine.arguments) {
    exit(TraySessionCLIRunner.run(request))
}

SliccstartApp.main()
