import Foundation

/// Queries the recent-agent-activity endpoint on every running local server.
/// Transport and decoding failures are intentionally treated as inactive so
/// an unreachable helper never blocks the launcher's update action.
struct AgentActivityProbe {
    let fetch: (URL) async throws -> (Int, Data)

    static let `default` = AgentActivityProbe(fetch: { url in
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.0
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    })

    func hasRecentActivity(servePorts: [UInt16]) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            for servePort in servePorts {
                group.addTask {
                    await isActive(servePort: servePort)
                }
            }

            var hasRecentActivity = false
            for await isActive in group {
                hasRecentActivity = hasRecentActivity || isActive
            }
            return hasRecentActivity
        }
    }

    private func isActive(servePort: UInt16) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(servePort)/api/agent-activity") else {
            return false
        }
        do {
            let (status, data) = try await fetch(url)
            guard status == 200 else { return false }
            let response = try JSONDecoder().decode(Response.self, from: data)
            return response.activeInLastMinute
        } catch {
            return false
        }
    }

    private struct Response: Decodable {
        let activeInLastMinute: Bool
    }
}
