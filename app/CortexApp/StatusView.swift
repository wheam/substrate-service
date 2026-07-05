import SwiftUI

struct StatusView: View {
    @State private var queued: [QueuedCapture] = []
    @State private var pending: [PendingEntry] = []
    @State private var events: [KeeperEvent] = []
    @State private var errorText: String?
    @State private var showSettings = false
    @State private var resolving: PendingEntry?

    var body: some View {
        NavigationStack {
            List {
                if let errorText {
                    Section { Text(errorText).foregroundStyle(.red).font(.footnote) }
                }
                if !queued.isEmpty {
                    Section("📤 未发送（离线队列，回网自动重试）") {
                        ForEach(queued) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.url ?? item.text ?? "").lineLimit(2)
                                if let note = item.note, !note.isEmpty {
                                    Text(note).font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                if !pending.isEmpty {
                    Section("⏳ keeper 处理中 / 待定夺（点开可裁定）") {
                        ForEach(pending) { entry in
                            Button {
                                resolving = entry
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.excerpt).lineLimit(2).foregroundStyle(.primary)
                                    Text("\(statusLabel(entry.status)) · \(entry.kind) · \(entry.client ?? "")")
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                Section("📋 keeper 裁决") {
                    if events.isEmpty {
                        Text("还没有记录——去任意 App 分享一条试试").foregroundStyle(.secondary)
                    }
                    ForEach(events) { event in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(verdictIcon(event.verdict)) \(event.summary ?? event.detail ?? "")").lineLimit(2)
                            Text(event.detail ?? "").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
            .navigationTitle("Cortex 收件箱")
            .toolbar {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
            }
            .sheet(isPresented: $showSettings, onDismiss: { Task { await refresh() } }) {
                SettingsView()
            }
            .sheet(item: $resolving, onDismiss: { Task { await refresh() } }) { entry in
                ResolveView(entry: entry, onResolved: {})
            }
            .refreshable { await refresh() }
            .task { await refresh() }
        }
    }

    private func refresh() async {
        _ = await CaptureQueue.flush()
        queued = CaptureQueue.load()
        guard AppConfig.isConfigured else {
            errorText = "先到 ⚙️ 设置里填服务地址和 token"
            return
        }
        do {
            let status = try await CaptureClient.status()
            pending = status.pending
            events = status.events
            errorText = nil
        } catch {
            errorText = "刷新失败：\(error.localizedDescription)"
        }
    }

    private func verdictIcon(_ verdict: String) -> String {
        switch verdict {
        case "filed": return "✅"
        case "removed": return "🗑️"
        case "rejected": return "❌"
        case "held": return "🤔"
        default: return "•"
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "pending": return "排队中"
        case "held": return "待你定夺（回任意 agent 处理）"
        case "rejected": return "已拒收"
        default: return status
        }
    }
}
