// 最小 CEF 启动诊断程序：用于把「内核能否起来」与「TiBrowser 外壳代码」分离定位。
// 用法：TiBrowserProbe.exe   —— 成功会弹出一个空白浏览器窗口。
#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_helpers.h"

#include <windows.h>

#include <fstream>
#include <string>

namespace {

std::string ProbeDir() {
  wchar_t buffer[MAX_PATH] = {0};
  DWORD len = ::GetModuleFileNameW(nullptr, buffer, MAX_PATH);
  std::wstring wpath(buffer, len);
  size_t pos = wpath.find_last_of(L"\\/");
  std::wstring wdir = pos == std::wstring::npos ? L"" : wpath.substr(0, pos);
  int size = ::WideCharToMultiByte(CP_UTF8, 0, wdir.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string dir(size > 0 ? size - 1 : 0, '\0');
  if (size > 1) ::WideCharToMultiByte(CP_UTF8, 0, wdir.c_str(), -1, dir.data(), size, nullptr, nullptr);
  return dir;
}

void Trace(const std::string& msg) {
  std::ofstream out(ProbeDir() + "\\probe.log", std::ios::app | std::ios::binary);
  if (out) {
    out << msg << "\n";
    out.flush();
  }
}

class ProbeClient : public CefClient, public CefLifeSpanHandler {
 public:
  ProbeClient() = default;
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    Trace("OnAfterCreated：网页视图已创建");
  }

 private:
  IMPLEMENT_REFCOUNTING(ProbeClient);
};

class ProbeWindow : public CefWindowDelegate, public CefBrowserViewDelegate {
 public:
  ProbeWindow() = default;

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    Trace("OnWindowCreated：窗口已创建");
    CefBrowserSettings settings;
    CefRefPtr<ProbeClient> client = new ProbeClient();
    Trace("准备调用 CreateBrowserView");
    // .release() 取得裸指针（脱离 CefRefPtr 的 adopt 语义），再交给成员 CefRefPtr
    CefBrowserView* raw_view =
        CefBrowserView::CreateBrowserView(client, "https://example.com/", settings, nullptr,
                                          nullptr, this)
            .release();
    Trace("CreateBrowserView 已返回");
    CefRefPtr<CefBrowserView> view = raw_view;
    window->AddChildView(view);
    window->Show();
    Trace("OnWindowCreated：视图已挂载并显示");
  }
  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override { Trace("OnWindowDestroyed"); }
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

 private:
  IMPLEMENT_REFCOUNTING(ProbeWindow);
};

class ProbeApp : public CefApp, public CefBrowserProcessHandler {
 public:
  ProbeApp() = default;
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();
    Trace("OnContextInitialized：创建顶层窗口");
    CefRefPtr<ProbeWindow> window = new ProbeWindow();
    CefWindow::CreateTopLevelWindow(window);
  }

 private:
  IMPLEMENT_REFCOUNTING(ProbeApp);
};

}  // namespace

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int) {
  Trace("=== 探针启动 ===");
  CefMainArgs args(instance);
  CefRefPtr<ProbeApp> app = new ProbeApp();
  Trace("调用 CefExecuteProcess");
  const int code = CefExecuteProcess(args, app.get(), nullptr);
  Trace("CefExecuteProcess 返回 " + std::to_string(code));
  if (code >= 0) return code;

  CefSettings settings;
  settings.no_sandbox = false;
  settings.multi_threaded_message_loop = false;
  settings.log_severity = LOGSEVERITY_INFO;
  CefString(&settings.root_cache_path) = ProbeDir() + "\\probe-data";
  CefString(&settings.log_file) = ProbeDir() + "\\probe-data\\cef.log";

  Trace("调用 CefInitialize");
  if (!CefInitialize(args, settings, app.get(), nullptr)) {
    Trace("CefInitialize 失败");
    return 1;
  }
  Trace("CefInitialize 成功");
  CefRunMessageLoop();
  Trace("消息循环结束");
  CefShutdown();
  return 0;
}
