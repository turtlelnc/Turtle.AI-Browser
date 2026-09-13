// TiBrowser 原生外壳入口（Chromium / CEF）
// 版本：v1.0.0-rc1 (build 260913)
#include "app.h"
#include "security.h"
#include "service_client.h"
#include "window.h"

#include <windows.h>

#include <shlobj.h>

#include <fstream>

#include "version.h"

namespace {

/** 取 %APPDATA%\TiBrowser，不存在则创建 */
std::string ResolveUserDataDir() {
  wchar_t* appdata = nullptr;
  std::string result;
  if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &appdata))) {
    const int size =
        ::WideCharToMultiByte(CP_UTF8, 0, appdata, -1, nullptr, 0, nullptr, nullptr);
    std::string base(size > 0 ? size - 1 : 0, '\0');
    if (size > 1) {
      ::WideCharToMultiByte(CP_UTF8, 0, appdata, -1, base.data(), size, nullptr, nullptr);
    }
    ::CoTaskMemFree(appdata);
    result = base + "\\TiBrowser";
  } else {
    result = tib::ExecutableDir() + "\\TiBrowserData";
  }
  ::CreateDirectoryA(result.c_str(), nullptr);
  return result;
}

}  // namespace

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int) {
  // 早期日志：在拿到 userData 目录之前就能落盘，便于排查启动即退出的问题
  const std::string early_log = tib::ExecutableDir() + "\\tibrowser-startup.log";
  auto early = [&](const std::string& msg) {
    std::ofstream out(early_log, std::ios::app | std::ios::binary);
    if (out) {
      out << msg << "\n";
      out.flush();  // 崩溃前必须落盘，否则看不到最后一步
    }
  };
  early("=== TiBrowser " TIB_VERSION_FULL " 启动 ===");

  // 单实例：已有实例时把焦点交给它，避免两个进程争抢同一个 profile
  HANDLE mutex = ::CreateMutexW(nullptr, TRUE, L"TiBrowser.SingleInstance.v1");
  if (mutex && ::GetLastError() == ERROR_ALREADY_EXISTS) {
    early("已有实例在运行，退出");
    ::CloseHandle(mutex);
    return 0;
  }

  CefMainArgs main_args(instance);
  CefRefPtr<tib::TibApp> app = new tib::TibApp();
  early("TibApp 已创建，获取执行状态");

  // 子进程（renderer / gpu / utility）走这里，直接返回
  const int exit_code = CefExecuteProcess(main_args, app.get(), nullptr);
  if (exit_code >= 0) return exit_code;
  early("确认当前是浏览器主进程，继续初始化");

  // 初始化上下文
  tib::AppContext& ctx = tib::AppContext::Get();
  ctx.set_app_dir(tib::ExecutableDir());
  ctx.set_user_data_dir(ResolveUserDataDir());
  ctx.set_incognito(false);
  early("程序目录 " + ctx.app_dir());
  early("用户数据目录 " + ctx.user_data_dir());

  // 读取命令行开关（无痕窗口、能效模式）
  CefRefPtr<CefCommandLine> command_line = CefCommandLine::CreateCommandLine();
  command_line->InitFromString(::GetCommandLineW());
  if (command_line->HasSwitch("incognito")) {
    ctx.set_incognito(true);
  }
  if (command_line->HasSwitch("energy-mode")) {
    ctx.set_energy_mode(command_line->GetSwitchValue("energy-mode").ToString());
  }

  CefSettings settings;
  // Chromium 的渲染进程沙箱在 Windows 上依赖 chrome_elf 引导；CEF 官方发行包要求
  // 应用自行承担引导配置，未配置时启动期会直接断言失败。这里先关闭内置沙箱，
  // 由外壳对网页进程做隔离（详见 docs/ARCHITECTURE.md 的安全说明）。
  settings.no_sandbox = true;
  settings.multi_threaded_message_loop = false;
  settings.windowless_rendering_enabled = false;
  settings.log_severity = LOGSEVERITY_INFO;
  settings.background_color = 0xFF1C1C1E;

  // 用户数据目录：Chromium profile 全部落在这里
  CefString(&settings.root_cache_path) = ctx.user_data_dir();
  CefString(&settings.cache_path) = ctx.user_data_dir() + "\\cache";
  CefString(&settings.log_file) = ctx.user_data_dir() + "\\cef.log";
  CefString(&settings.user_agent_product) = "TiBrowser/" TIB_VERSION;

  early("调用 CefInitialize ...");
  if (!CefInitialize(main_args, settings, app.get(), nullptr)) {
    early("CefInitialize 失败");
    ::MessageBoxW(nullptr,
                  L"TiBrowser 初始化 Chromium 内核失败。\n\n请检查程序目录下是否存在 libcef.dll、\n"
                  L"resources.pak、icudtl.dat 与 locales 目录，\n"
                  L"详细日志见程序目录下 tibrowser-startup.log 与 cef.log。",
                  L"" TIB_PRODUCT_NAME, MB_ICONERROR | MB_OK);
    return 1;
  }
  early("CefInitialize 成功，进入消息循环");

  // 安全浏览与边车：内核起来后再做，避免拖慢首屏
  tib::InitSecurity();
  const tib::ServiceState service = tib::StartService(ctx.energy_mode());
  early(std::string("边车状态：") + (service.running ? "运行中" : "未启动"));

  CefRunMessageLoop();
  early("消息循环结束，关闭内核");
  CefShutdown();
  tib::StopService();

  if (mutex) ::CloseHandle(mutex);
  return 0;
}
