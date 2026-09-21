import Foundation

// Headless `Sliccstart --list-sessions [--reveal-urls]` short-circuits before
// the SwiftUI app boots so the `slicc` CLI can read iCloud tray sessions from
// the signed, iCloud-entitled launcher binary. Any other launch falls through
// to the normal GUI app.
if let request = TraySessionCLI.parse(CommandLine.arguments) {
    exit(TraySessionCLIRunner.run(request))
}

// Same shape for the headless computer follower `slicc … follow --computer`
// spawns (#3260): capture and input have to be asked for by a signed bundle, so
// the CLI starts this binary instead of trying to take the screen itself.
//
// A malformed invocation exits rather than falling through to the GUI — booting
// the menu-bar app would be indistinguishable, from the CLI's side, from a
// launcher too old to know the flag.
do {
    if let request = try ComputerFollowCLI.parse(CommandLine.arguments) {
        exit(ComputerFollowCLIRunner.run(request))
    }
} catch let error as ComputerFollowCLI.ParseError {
    FileHandle.standardError.write(Data(error.message.utf8))
    exit(ComputerFollowCLI.usageExitCode)
}

SliccstartApp.main()
