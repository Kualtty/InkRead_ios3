import SwiftUI

@main
struct InkReaderIOSApp: App {
    var body: some Scene {
        WindowGroup {
            WebShellView()
                .ignoresSafeArea()          // 前端自己按 env(safe-area-inset-*) 排，别再叠一层
                .background(Color(.systemBackground))
        }
    }
}
