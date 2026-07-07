import Foundation

/// App 与分享扩展共享的配置（App Group）。
/// v0 说明：token 存 App Group UserDefaults——它是 capture-only token（只能投递、看自己的回执），
/// 泄露面有界；正式版换 Keychain 共享组。
enum AppConfig {
    static let appGroup = "group.com.wheam.cortex"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    static var serverURL: String {
        get { defaults.string(forKey: "serverURL") ?? "" }
        set { defaults.set(newValue, forKey: "serverURL") }
    }

    static var token: String {
        get { defaults.string(forKey: "captureToken") ?? "" }
        set { defaults.set(newValue, forKey: "captureToken") }
    }

    static var isConfigured: Bool { !token.isEmpty && !serverURL.isEmpty }

    static var queueFileURL: URL {
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return container.appendingPathComponent("capture-queue.json")
    }
}
