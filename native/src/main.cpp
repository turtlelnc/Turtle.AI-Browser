// TiBrowser 原生外壳入口（Chromium / CEF）
// 版本：v1.0.0-rc1 (build 260913)
#include "app.h"
#include "security.h"
#include "service_client.h"
#include "window.h"

#include <windows.h>

#include <shlobj.h>

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
  // 单实例：已有实例时把焦点交给它，避免两个进程争抢同一个 profile
  HANDLE mutex = ::CreateMutexW(nullptr, TRUE, L"TiBrowser.SingleInstance.v1");
  if (mutex && ::GetLastError() == ERROR_ALREADY_EXISTS) {
    if (HWND existing = ::FindWindowW(nullptr, L"" TIB_PRODUCT_NAME)) {
      ::SetForegroundWindow(existing);
    }
    ::CloseHandle(mutex);
    return 0;
  }

  CefMainArgs main_args(instance);
  CefRefPtr<tib::TibApp> app = new tib::TibApp();

  // 子进程（renderer / gpu / utility）走这里，直接返回
  const int exit_code = CefExecuteProcess(main_args, app.get(), nullptr);
  if (exit_code >= 0) return exit_code;

  // 初始化上下文
  tib::AppContext& ctx = tib::AppContext::Get();
  ctx.set_app_dir(tib::ExecutableDir());
  ctx.set_user_data_dir(ResolveUserDataDir());
  ctx.set_incognito(false);

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
  settings.no_sandbox = false;
  settings.multi_threaded_message_loop = false;
  settings.windowless_rendering_enabled = false;
  settings.log_severity = LOGSEVERITY_WARNING;
  settings.background_color = 0xFF1C1C1E;

  // 用户数据目录：Chromium profile 全部落在这里
  CefString(&settings.root_cache_path) = ctx.user_data_dir();
  CefString(&settings.cache_path) = ctx.user_data_dir() + "\\cache";
  CefString(&settings.user_agent_product) = "TiBrowser/" TIB_VERSION;

  if (!CefInitialize(main_args, settings, app.get(), nullptr)) {
    ::MessageBoxW(nullptr,
                  L"TiBrowser 初始化 Chromium 内核失败。\n请检查程序目录下是否存在 libcef.dll 与 "
                  L"resources 目录。",
                  L"" TIB_PRODUCT_NAME, MB_ICONERROR | MB_OK);
    return 1;
  }

  // 安全浏览与边车：内核起来后再做，避免拖慢首屏
  tib::InitSecurity();
  const tib::ServiceState service = tib::StartService(ctx.energy_mode());

  CefRunMessageLoop();
  CefShutdown();
  tib::StopService();

  if (mutex) ::CloseHandle(mutex);
  return 0;
}
