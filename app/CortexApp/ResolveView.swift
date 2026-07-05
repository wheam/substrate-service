import SwiftUI

/// 收件审阅：看全文 → 一句话裁定（或快捷键）→ keeper 按裁定执行并自动立判例。
struct ResolveView: View {
    let entry: PendingEntry
    let onResolved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var ruling = ""
    @State private var busy = false
    @State private var errorText: String?

    private let presets = ["进待办", "存进知识库", "记为关于我的事实", "扔掉别存"]

    var body: some View {
        NavigationStack {
            Form {
                Section("内容") {
                    Text(entry.content ?? entry.excerpt)
                        .font(.callout)
                        .textSelection(.enabled)
                }
                Section("状态") {
                    LabeledContent("状态", value: statusLabel)
                    if let hint = entry.hint, !hint.isEmpty {
                        LabeledContent("意图提示", value: hint)
                    }
                    LabeledContent("来源", value: entry.client ?? "-")
                }
                Section("你的裁定") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(presets, id: \.self) { p in
                                Button(p) { ruling = p }
                                    .buttonStyle(.bordered)
                                    .font(.footnote)
                            }
                        }
                    }
                    TextField("一句话（如：这条进 todo / 并入某某页）", text: $ruling, axis: .vertical)
                    if let errorText {
                        Text(errorText).foregroundStyle(.red).font(.footnote)
                    }
                    Button {
                        Task { await submit() }
                    } label: {
                        if busy { ProgressView() } else { Text("提交裁定").frame(maxWidth: .infinity) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || ruling.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .navigationTitle("待你定夺")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
            }
        }
    }

    private var statusLabel: String {
        switch entry.status {
        case "pending": return "排队中"
        case "held": return "keeper 拿不准，等你"
        case "rejected": return "已拒收"
        default: return entry.status
        }
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            try await CaptureClient.resolve(id: entry.id, ruling: ruling.trimmingCharacters(in: .whitespaces))
            onResolved()
            dismiss()
        } catch {
            errorText = "提交失败：\(error.localizedDescription)"
        }
    }
}
