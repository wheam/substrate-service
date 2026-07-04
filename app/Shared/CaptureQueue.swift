import Foundation

/// 离线队列：分享扩展先落盘再尝试发送；失败的件由主 App 回前台时重试。
/// 文件放 App Group 容器，扩展与主 App 共享。
struct QueuedCapture: Codable, Identifiable {
    let id: UUID
    let url: String?
    let text: String?
    let note: String?
    let createdAt: Date
}

enum CaptureQueue {
    private static let fileURL = AppConfig.queueFileURL

    static func load() -> [QueuedCapture] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([QueuedCapture].self, from: data)) ?? []
    }

    private static func save(_ items: [QueuedCapture]) {
        if let data = try? JSONEncoder().encode(items) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }

    static func enqueue(url: String?, text: String?, note: String?) -> QueuedCapture {
        let item = QueuedCapture(id: UUID(), url: url, text: text, note: note, createdAt: Date())
        save(load() + [item])
        return item
    }

    static func remove(id: UUID) {
        save(load().filter { $0.id != id })
    }

    /// 逐条重发；网络类失败即停（等下次），服务端 4xx 拒收则移除（重发也不会成功）。
    @discardableResult
    static func flush() async -> (sent: Int, remaining: Int) {
        var sent = 0
        for item in load() {
            do {
                _ = try await CaptureClient.post(url: item.url, text: item.text, note: item.note)
                remove(id: item.id)
                sent += 1
            } catch CaptureError.server(let msg) {
                // 服务端明确拒绝（如密钥红线）：留着重发没有意义，移除并记录
                remove(id: item.id)
                NSLog("capture 被拒收，移出队列：%@", msg)
            } catch {
                break // 网络不通等，保队列等下次
            }
        }
        return (sent, load().count)
    }
}
