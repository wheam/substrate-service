import Foundation

struct CaptureResponse: Codable {
    let ok: Bool
    let id: String?
    let path: String?
    let error: String?
}

struct PendingEntry: Codable, Identifiable {
    let id: String
    let path: String
    let kind: String
    let status: String
    let received_at: String
    let hint: String?
    let excerpt: String
}

struct KeeperEvent: Codable, Identifiable {
    let id: String
    let client: String
    let kind: String?
    let verdict: String
    let detail: String?
    let summary: String?
    let ts: String
}

struct StatusResponse: Codable {
    let ok: Bool
    let pending: [PendingEntry]
    let events: [KeeperEvent]
}

enum CaptureError: Error, LocalizedError {
    case notConfigured
    case server(String)
    var errorDescription: String? {
        switch self {
        case .notConfigured: return "还没配置服务地址和 token（去主 App 设置页）"
        case .server(let msg): return msg
        }
    }
}

enum CaptureClient {
    static func post(url: String?, text: String?, note: String?) async throws -> CaptureResponse {
        guard AppConfig.isConfigured, let endpoint = URL(string: AppConfig.serverURL + "/capture") else {
            throw CaptureError.notConfigured
        }
        var req = URLRequest(url: endpoint, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(AppConfig.token)", forHTTPHeaderField: "Authorization")
        var body: [String: String] = [:]
        if let url, !url.isEmpty { body["url"] = url }
        if let text, !text.isEmpty { body["text"] = text }
        if let note, !note.isEmpty { body["note"] = note }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: req)
        let decoded = try JSONDecoder().decode(CaptureResponse.self, from: data)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, decoded.ok else {
            throw CaptureError.server(decoded.error ?? "服务返回异常")
        }
        return decoded
    }

    static func status() async throws -> StatusResponse {
        guard AppConfig.isConfigured, let endpoint = URL(string: AppConfig.serverURL + "/capture/status") else {
            throw CaptureError.notConfigured
        }
        var req = URLRequest(url: endpoint, timeoutInterval: 15)
        req.setValue("Bearer \(AppConfig.token)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(StatusResponse.self, from: data)
    }
}
