import Foundation



BrokenPipeSignal.ignore()





if let request = TraySessionCLI.parse(CommandLine.arguments) {
    exit(TraySessionCLIRunner.run(request))
}








do {
    if let request = try ComputerFollowCLI.parse(CommandLine.arguments) {
        exit(ComputerFollowCLIRunner.run(request))
    }
} catch let error as ComputerFollowCLI.ParseError {
    try? FileHandle.standardError.write(contentsOf: Data(error.message.utf8))
    exit(ComputerFollowCLI.usageExitCode)
}

SliccstartApp.main()
