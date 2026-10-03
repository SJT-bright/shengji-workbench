import AppKit
import WebKit
import Darwin

final class ShengjiApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var status: NSTextField!
    private var server: Process?
    private var logHandle: FileHandle?
    private let token = UUID().uuidString
    private let baseURL = URL(string: "http://127.0.0.1:5189/")!
    private var folders = Set<String>()
    private var stopping = false
    private var checkingTermination = false
    private var pageReady = false
    private var pendingFiles: [URL] = []
    private var pendingRecord: String?
    private var importingFiles = false
    private let defaultInbox = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents/声迹收件箱", isDirectory: true)
    private let dataURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Shengji", isDirectory: true)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        folders.formUnion(UserDefaults.standard.stringArray(forKey: "selectedFolders") ?? [])
        let controller = WKUserContentController()
        controller.add(self, name: "shengji")
        let script = "window.__SHENGJI_TOKEN='\(token)';window.__SHENGJI_NATIVE=true;"
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "声迹 · 录音转写助手"
        window.minSize = NSSize(width: 860, height: 640)
        window.isReleasedWhenClosed = false
        window.center()
        window.contentView = webView
        status = NSTextField(wrappingLabelWithString: "正在打开你的声迹工作台…")
        status.alignment = .center
        status.font = NSFont.systemFont(ofSize: 16)
        status.textColor = NSColor(calibratedRed: 0.22, green: 0.36, blue: 0.28, alpha: 1)
        status.translatesAutoresizingMaskIntoConstraints = false
        webView.addSubview(status)
        NSLayoutConstraint.activate([status.centerXAnchor.constraint(equalTo: webView.centerXAnchor), status.centerYAnchor.constraint(equalTo: webView.centerYAnchor), status.widthAnchor.constraint(lessThanOrEqualToConstant: 620)])
        showWindow()
        launchServer()
    }

    private func buildMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "显示声迹工作台", action: #selector(showWindow), keyEquivalent: "0").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏声迹", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出声迹", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }

    @objc private func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if url.isFileURL { pendingFiles.append(url) }
            else if url.scheme == "shengji", url.host == "record", url.pathComponents.count == 2 {
                let id = url.lastPathComponent
                if !id.isEmpty && id.count <= 200 { pendingRecord = id }
            }
        }
        showWindow()
        if pageReady { deliverPendingRecord(); importNextFile() }
    }
    private func deliverPendingRecord() {
        guard pageReady, let id = pendingRecord else { return }
        pendingRecord = nil
        dispatchEvent("shengji-open-record", detail: ["id": id])
    }
    private func importNextFile() {
        guard pageReady, !importingFiles, !pendingFiles.isEmpty else { return }
        importingFiles = true
        let file = pendingFiles.removeFirst()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let ext = file.pathExtension.lowercased()
                let audio = ["mp3", "m4a", "wav"].contains(ext)
                guard audio || ["txt", "md", "srt", "vtt"].contains(ext) else { throw NSError(domain: "Shengji", code: 1, userInfo: [NSLocalizedDescriptionKey: "不支持这个文件格式"]) }
                let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
                let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
                guard attrs[.type] as? FileAttributeType == .typeRegular, size > 0, size <= (audio ? 100 : 5) * 1024 * 1024 else { throw NSError(domain: "Shengji", code: 2, userInfo: [NSLocalizedDescriptionKey: "文件为空或超过导入上限"]) }
                let data = try Data(contentsOf: file)
                var payload: [String: Any] = [:]
                if audio { payload["audio"] = ["name": file.lastPathComponent, "data": data.base64EncodedString()] }
                else {
                    guard let text = String(data: data, encoding: .utf8) else { throw NSError(domain: "Shengji", code: 3, userInfo: [NSLocalizedDescriptionKey: "文字文件需要 UTF-8 编码"]) }
                    guard text.count <= 500_000 else { throw NSError(domain: "Shengji", code: 4, userInfo: [NSLocalizedDescriptionKey: "文字超过 50 万字符，请拆分后导入"]) }
                    payload["text"] = text; payload["filename"] = file.lastPathComponent
                }
                var request = URLRequest(url: self.baseURL.appendingPathComponent(audio ? "api/import-audio" : "api/import"))
                request.httpMethod = "POST"; request.timeoutInterval = 120
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue(self.token, forHTTPHeaderField: "X-Shengji-Token")
                request.httpBody = try JSONSerialization.data(withJSONObject: payload)
                URLSession.shared.dataTask(with: request) { data, response, error in
                    var detail: [String: String] = [:]
                    if let error = error { detail["error"] = error.localizedDescription }
                    else if let data = data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        if let record = body["record"] as? [String: Any], let id = record["id"] as? String { detail["id"] = id }
                        else { detail["error"] = body["error"] as? String ?? "文件导入未成功" }
                    } else { detail["error"] = "本地服务没有返回有效结果" }
                    DispatchQueue.main.async { self.importingFiles = false; self.dispatchEvent("shengji-import-result", detail: detail); self.importNextFile() }
                }.resume()
            } catch {
                DispatchQueue.main.async { self.importingFiles = false; self.dispatchEvent("shengji-import-result", detail: ["error": "\(file.lastPathComponent)：\(error.localizedDescription)"]); self.importNextFile() }
            }
        }
    }

    private func portAvailable() -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        // A recently closed local server may leave connections in TIME_WAIT.
        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = UInt16(5189).bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &address) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
        }
    }

    private func launchServer() {
        guard portAvailable() else { fail("无法启动：本机 5189 端口已被占用。\n请先关闭占用该端口的程序，然后重新打开声迹。\n声迹不会连接或终止其他程序的服务。"); return }
        guard let resources = Bundle.main.resourceURL else { fail("应用资源缺失，请重新构建声迹。"); return }
        do {
            try FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true)
            let inbox = defaultInbox
            try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
            folders.insert(inbox.resolvingSymlinksInPath().standardizedFileURL.path)
            folders.insert(dataURL.resolvingSymlinksInPath().standardizedFileURL.path)
            let logURL = dataURL.appendingPathComponent("app.log")
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
            logHandle = try FileHandle(forWritingTo: logURL)
            logHandle?.seekToEndOfFile()
            let child = Process()
            child.executableURL = resources.appendingPathComponent("node")
            child.arguments = ["server.mjs"]
            child.currentDirectoryURL = resources.appendingPathComponent("app", isDirectory: true)
            var environment = ProcessInfo.processInfo.environment
            environment["SHENGJI_PORT"] = "5189"
            environment["SHENGJI_DATA_DIR"] = dataURL.path
            environment["SHENGJI_TOKEN"] = token
            child.environment = environment
            child.standardOutput = logHandle
            child.standardError = logHandle
            child.terminationHandler = { [weak self] process in
                DispatchQueue.main.async {
                    guard let self = self, !self.stopping else { return }
                    self.fail("声迹本地服务已停止（退出码 \(process.terminationStatus)）。\n请重新打开应用。日志：\(self.dataURL.appendingPathComponent("app.log").path)")
                }
            }
            server = child
            try child.run()
            waitForServer(attempt: 0)
        } catch { fail("本地服务启动失败：\(error.localizedDescription)") }
    }

    private func waitForServer(attempt: Int) {
        guard server?.isRunning == true, !stopping else { return }
        if attempt >= 60 { server?.terminate(); fail("本地服务未能就绪。\n请重新打开应用，或查看 ~/Library/Application Support/Shengji/app.log。"); return }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.server?.isRunning == true, !self.stopping else { return }
                if let data = data, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], value["app"] as? String == "shengji", value["ok"] as? Bool == true, (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.webView.load(URLRequest(url: self.baseURL))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.waitForServer(attempt: attempt + 1) }
                }
            }
        }.resume()
    }
    private func fail(_ text: String) { status.stringValue = text; status.isHidden = false }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { status.isHidden = true; pageReady = true; deliverPendingRecord(); importNextFile() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("页面打开失败：\(error.localizedDescription)") }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "http", url.host == "127.0.0.1", url.port == 5189 { decisionHandler(.allow); return }
        if ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "声迹"; alert.informativeText = message; alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "声迹"; alert.informativeText = message; alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.canChooseFiles = true; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, url.host == "127.0.0.1", url.port == 5189,
              let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "copyText":
            guard let text = body["text"] as? String else { return }
            guard text.count <= 2000 else { dispatchEvent("shengji-model", detail: ["error": "内容超出复制上限"]); return }
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        case "share":
            guard let content = body["content"] as? String else { return }
            guard content.count <= 700000 else { dispatchEvent("shengji-model", detail: ["error": "内容超出分享上限"]); return }
            let picker = NSSharingServicePicker(items: [content])
            picker.show(relativeTo: NSRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1), of: webView, preferredEdge: .minY)
        case "chooseFolder":
            let panel = NSOpenPanel(); panel.title = "选择录音转写收件目录"; panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { [weak self] response in
                guard let self = self, response == .OK, let url = panel.url else { return }
                let path = url.resolvingSymlinksInPath().standardizedFileURL.path
                self.folders.insert(path)
                UserDefaults.standard.set(Array(self.folders), forKey: "selectedFolders")
                let encoded = try! JSONSerialization.data(withJSONObject: ["path": path])
                let json = String(data: encoded, encoding: .utf8)!
                self.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('shengji-folder',{detail:\(json)}))")
            }
        case "openFolder":
            let path = (body["path"] as? String) ?? defaultInbox.path
            let url = URL(fileURLWithPath: path, isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
            guard folders.contains(url.path) else {
                DispatchQueue.main.async { self.dispatchEvent("shengji-model", detail: ["error": "该文件夹未在应用内授权，请先在「自动整理设置」中重新选择"]) }
                return
            }
            NSWorkspace.shared.open(url)
        case "export":
            guard let content = body["content"] as? String else { return }
            let panel = NSSavePanel(); panel.nameFieldStringValue = URL(fileURLWithPath: (body["filename"] as? String) ?? "声迹导出.md").lastPathComponent; panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { [weak self] response in
                guard response == .OK, let url = panel.url else { return }
                do {
                    try content.write(to: url, atomically: true, encoding: .utf8)
                    self?.dispatchEvent("shengji-export", detail: ["path": url.path])
                } catch {
                    self?.dispatchEvent("shengji-export", detail: ["error": error.localizedDescription])
                }
            }
        case "startOllama":
            let fixedURL = URL(fileURLWithPath: "/Applications/Ollama.app", isDirectory: true)
            let applicationURL = FileManager.default.fileExists(atPath: fixedURL.path) ? fixedURL : NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.ollama.ollama")
            guard let applicationURL = applicationURL else {
                dispatchEvent("shengji-model", detail: ["error": "未找到本机 Ollama 应用，请先安装 Ollama。"])
                return
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            NSWorkspace.shared.openApplication(at: applicationURL, configuration: configuration) { [weak self] app, error in
                DispatchQueue.main.async {
                    if let error = error {
                        self?.dispatchEvent("shengji-model", detail: ["error": "Ollama 启动失败：\(error.localizedDescription)"])
                    } else {
                        self?.dispatchEvent("shengji-model", detail: ["message": "已打开 Ollama，模型服务启动后即可使用。", "status": "started"])
                    }
                }
            }
        default: break
        }
    }
    private func dispatchEvent(_ name: String, detail: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(name)',{detail:\(json)}))")
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if checkingTermination { return .terminateCancel }
        guard webView != nil else { return .terminateNow }
        checkingTermination = true
        webView.evaluateJavaScript("window.__shengjiHasUnsavedChanges?.() || false") { [weak self] value, error in
            guard let self = self else { sender.reply(toApplicationShouldTerminate: true); return }
            if value as? Bool == true {
                let alert = NSAlert()
                alert.messageText = "还有未保存的整理"
                alert.informativeText = "退出会丢弃这些修改。确定退出声迹吗？"
                alert.addButton(withTitle: "继续编辑")
                alert.addButton(withTitle: "放弃修改并退出")
                self.showWindow()
                alert.beginSheetModal(for: self.window) { response in
                    self.checkingTermination = false
                    sender.reply(toApplicationShouldTerminate: response == .alertSecondButtonReturn)
                }
            } else {
                self.checkingTermination = false
                sender.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) {
        stopping = true
        if let server = server, server.isRunning { server.terminate(); server.waitUntilExit() }
        try? logHandle?.close()
    }
}
let app = NSApplication.shared
let delegate = ShengjiApp()
app.delegate = delegate
app.run()
