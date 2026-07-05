import SwiftUI

/// 收件审阅：干净正文 + keeper 的困惑（人话）+ 候选方案一键选；实在不对再自己写一句。
struct ResolveView: View {
    let entry: PendingEntry
    let onResolved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var ruling = ""
    @State private var busySubmit: Int? = nil   // 正在提交的候选 index；-1 = 自由文本
    @State private var errorText: String?
    @State private var showFreeform = false

    var body: some View {
        NavigationStack {
            Form {
                Section("要存的内容") {
                    Text(entry.content ?? entry.excerpt)
                        .font(.callout)
                        .textSelection(.enabled)
                    if let hint = entry.hint, !hint.isEmpty {
                        Label(hint, systemImage: "tag")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let reason = entry.reason, !reason.isEmpty {
                    Section("keeper 为什么拿不准") {
                        Text(reason).font(.callout).foregroundStyle(.secondary)
                    }
                }
                if let options = entry.options, !options.isEmpty {
                    Section("怎么处理？点一个") {
                        ForEach(options) { opt in
                            Button {
                                Task { await submit(option: opt.index) }
                            } label: {
                                HStack {
                                    Text("\(opt.index + 1)").bold().foregroundStyle(.secondary)
                                    Text(opt.label).multilineTextAlignment(.leading)
                                    Spacer()
                                    if busySubmit == opt.index { ProgressView() }
                                }
                            }
                            .disabled(busySubmit != nil)
                        }
                    }
                }
                Section {
                    DisclosureGroup("都不合适？自己说一句", isExpanded: $showFreeform) {
                        TextField("如：这条进 todo / 并入某某页 / 扔掉", text: $ruling, axis: .vertical)
                        Button {
                            Task { await submit(option: nil) }
                        } label: {
                            if busySubmit == -1 { ProgressView() } else { Text("提交").frame(maxWidth: .infinity) }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(busySubmit != nil || ruling.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    if let errorText {
                        Text(errorText).foregroundStyle(.red).font(.footnote)
                    }
                } footer: {
                    Text("来源：\(entry.client ?? "-") · 你的选择会成为 keeper 的判例，它下次会学乖")
                }
            }
            .navigationTitle("待你定夺")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
            }
        }
    }

    private func submit(option: Int?) async {
        busySubmit = option ?? -1
        defer { busySubmit = nil }
        do {
            if let option {
                try await CaptureClient.resolve(id: entry.id, option: option)
            } else {
                try await CaptureClient.resolve(id: entry.id, ruling: ruling.trimmingCharacters(in: .whitespaces))
            }
            onResolved()
            dismiss()
        } catch {
            errorText = "提交失败：\(error.localizedDescription)"
        }
    }
}
