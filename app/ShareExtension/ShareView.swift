import SwiftUI

struct ShareContent {
    let url: String?
    let text: String?
}

/// 一步存：预览 + 可跳过的一句话意图 + 保存。
/// 先落本地队列（永不丢件），再尝试即时发送；网络不行就交给主 App 重试。
struct ShareView: View {
    let content: ShareContent
    let onDone: () -> Void
    let onCancel: () -> Void

    @State private var note = ""
    @State private var state: SendState = .editing

    enum SendState { case editing, sending, queued(String), sent }

    var body: some View {
        NavigationStack {
            Form {
                Section("要存的内容") {
                    Text(content.url ?? content.text ?? "（空）")
                        .lineLimit(4)
                        .font(.callout)
                }
                Section {
                    TextField("一句话意图（可不填）：想试 / 决定 / 待办…", text: $note)
                }
                switch state {
                case .sending:
                    HStack { ProgressView(); Text(" 发送中…") }
                case .queued(let why):
                    Text("📥 已进离线队列（\(why)），回网后自动送达").font(.footnote)
                case .sent:
                    Text("✅ 已受理，keeper 审核后飞书通知").font(.footnote)
                case .editing:
                    EmptyView()
                }
            }
            .navigationTitle("存进 Cortex")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }
                        .disabled(!isEditing)
                }
            }
            .interactiveDismissDisabled(!isEditing)
        }
    }

    private var isEditing: Bool { if case .editing = state { return true } else { return false } }

    private func save() async {
        state = .sending
        let item = CaptureQueue.enqueue(url: content.url, text: content.text, note: note)
        do {
            _ = try await CaptureClient.post(url: item.url, text: item.text, note: item.note)
            CaptureQueue.remove(id: item.id)
            state = .sent
        } catch CaptureError.server(let msg) {
            CaptureQueue.remove(id: item.id) // 服务端拒收（如密钥红线），重试无意义
            state = .queued("被拒收：\(msg)")
        } catch {
            state = .queued("暂时没网")
        }
        try? await Task.sleep(for: .seconds(1.2))
        onDone()
    }
}
