# Cortex iOS App（v0）

分享扩展一步存 + 离线队列自动重试 + keeper 状态页。对应方案 01 §M3。

## 结构

```
project.yml       xcodegen 工程声明（xcodeproj 不入库，现场生成）
Shared/           App 与扩展共享：配置(App Group)、/capture 客户端、离线队列
CortexApp/        主 App：状态页（未发送/处理中/keeper 裁决）+ 设置（服务地址、token）
ShareExtension/   分享扩展：URL/文本 + 一句话意图 → 先落队列再即时发送
```

## 本地跑（模拟器）

```bash
brew install xcodegen   # 已装可跳过
cd app && xcodegen generate
open Cortex.xcodeproj   # Xcode 里选 Cortex scheme + 任一 iPhone 模拟器 ▶️
```

首次启动进 ⚙️ 设置：填写自己的服务地址并粘贴 capture token。
测分享扩展：模拟器里开 Safari → 任意网页 → 分享 → 「存进 Cortex」。

## 真机 / TestFlight

需要 Apple Developer 账号（$99/年）：生成工程后，在 Xcode 两个 target 的 Signing 里选择你自己的 Team，
并把 bundle id / App Group 改成你账号下可用的唯一标识，
真机直接 ▶️；TestFlight 走 Product → Archive → Distribute。

## v0 边界（有意的）

- 只接 URL / 文本（截图/图片捕获是 v0.2——需要先定图片的存储与判断方案）
- token 存 App Group UserDefaults（capture-only、泄露面有界；正式版换共享 Keychain）
- 离线重试靠主 App 回前台触发（后台 BGTask 是 v0.2）
