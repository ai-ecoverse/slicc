import Foundation

if let request = TraySessionCLI.parse(CommandLine.arguments) {
    exit(TraySessionCLIRunner.run(request))
}

SliccstartApp.main()
