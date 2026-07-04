import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var serverURL = AppConfig.serverURL
    @State private var token = AppConfig.token

    var body: some View {
        NavigationStack {
            Form {
                Section("服务") {
                    TextField("服务地址", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    SecureField("capture token", text: $token)
                } header: {
                    Text("Token")
                } footer: {
                    Text("这把 token 只能投递内容和查看自己的回执，读不了库。")
                }
            }
            .navigationTitle("设置")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        AppConfig.serverURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        AppConfig.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
                        dismiss()
                    }
                }
            }
        }
    }
}
