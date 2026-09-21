import Foundation





if let request = TraySessionCLI.parse(CommandLine.arguments) {
    exit(TraySessionCLIRunner.run(request))
}








do {
    if let request = try ComputerFollowCLI.parse(CommandLine.arguments) {
        exit(ComputerFollowCLIRunner.run(request))
    }
} catch let error as ComputerFollowCLI.ParseError {
    FileHandle.standardError.write(Data(error.message.utf8))
    exit(ComputerFollowCLI.usageExitCode)
}

SliccstartApp.main()
