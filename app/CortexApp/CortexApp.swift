import SwiftUI

@main
struct CortexApp: App {
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            StatusView()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await CaptureQueue.flush() }
            }
        }
    }
}
