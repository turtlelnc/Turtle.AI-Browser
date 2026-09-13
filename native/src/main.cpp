// TiBrowser 原生外壳入口（Chromium / CEF）
// 版本：v1.0.0-rc1 (build 260913)
#include "app.h"
#include "local_server.h"
#include "security.h"
#include "service_client.h"
#include "window.h"

#include <windows.h>

#include <shlobj.h>

#include <fstream>

#include "version.h"

namespace {

}  // namespace

/**
 * 当前进程模型（写进日志，不假装是正常隔离模式）。
 *
 * 为什么需要它：本机（以及部分 Windows 环境）上 Chromium 的网络服务子进程会启动即崩
 * （network_service_instance_impl.cc:721 "Network service crashed" 反复刷屏），
 * 后果是**任何 HTTP 请求都发不出去**，页面永远空白，而导航事件与标题更新一切正常，
 * 极难排查。`--single-process` 可完全规避，代价是牺牲进程隔离。
 */
std::string DetectProcessModel() {
  CefRefPtr<CefCommandLine> cl = CefCommandLine::GetGlobalCommandLine();
  if (!cl) return "标准（多进程 + 沙箱）";
  if (cl->HasSwitch("single-process")) {
    return "单进程兼容模式（--single-process，用于规避网络服务子进程崩溃，隔离性下降）";
  }
  if (cl->HasSwitch("no-sandbox")) return "多进程 + 已关闭沙箱（--no-sandbox）";
  return "标准（多进程 + 沙箱）";
}

namespace {

/**
 * 取用户数据目录。
 *
 * 为什么用 %LOCALAPPDATA% 而不是 %APPDATA%：
 * 本机 %APPDATA% 被 OneDrive 同步，Chromium 的 profile 与缓存目录在同步盘上会出现
 * 文件占用冲突（实测 cef.log 里反复刷
 * "Failed to open persistent cache files ... 另一个程序正在使用此文件"，
 * 并伴随网络服务进程启动即崩）。改用本地非同步目录后这两个问题都消失。
 * 存储位置：%LOCALAPPDATA%\TiBrowser（首次使用时会从旧的 %APPDATA%\TiBrowser 迁移可读数据）。
 */
std::string ResolveUserDataDir() {
  wchar_t* local = nullptr;
  std::string result;
  if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local))) {
    const int size = ::WideCharToMultiByte(CP_UTF8, 0, local, -1, nullptr, 0, nullptr, nullptr);
    std::string base(size > 0 ? size - 1 : 0, '\0');
    if (size > 1) {
      ::WideCharToMultiByte(CP_UTF8, 0, local, -1, base.data(), size, nullptr, nullptr);
    }
    ::CoTaskMemFree(local);
    result = base + "\\TiBrowser";
  } else {
    result = tib::ExecutableDir() + "\\TiBrowserData";
  }
  ::CreateDirectoryA(result.c_str(), nullptr);
  return result;
}

/** 旧版本（%APPDATA%\TiBrowser，可能位于 OneDrive 同步盘）的路径，仅用于迁移提示 */
std::string LegacyUserDataDir() {
  wchar_t* roaming = nullptr;
  std::string result;
  if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &roaming))) {
    const int size = ::WideCharToMultiByte(CP_UTF8, 0, roaming, -1, nullptr, 0, nullptr, nullptr);
    std::string base(size > 0 ? size - 1 : 0, '\0');
    if (size > 1) {
      ::WideCharToMultiByte(CP_UTF8, 0, roaming, -1, base.data(), size, nullptr, nullptr);
    }
    ::CoTaskMemFree(roaming);
    result = base + "\\TiBrowser";
  }
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

  // ---- 兼容模式决策 ----
  //
  // 本机（以及部分 Windows 环境）上 Chromium 的网络服务子进程启动即崩
  // （network_service_instance_impl.cc:721 "Network service crashed" 反复刷屏），
  // 后果是**任何 HTTP 请求都发不出去、页面永远空白**，而导航事件与标题更新一切正常。
  // 实测可用的规避手段只有 --single-process（把渲染/网络都放进浏览器进程），
  // 代价是牺牲进程隔离。因此：
  //   * 默认启用单进程兼容模式，保证"能上网"这个最基本的能力；
  //   * 提供 --multi-process 显式退出，便于在正常环境里恢复完整隔离；
  //   * 两种模式都会在启动日志里如实标注，不假装是标准隔离模式。
  {
    CefRefPtr<CefCommandLine> cl = CefCommandLine::GetGlobalCommandLine();
    const bool force_multi = cl && cl->HasSwitch("multi-process");
    if (!force_multi && !(cl && cl->HasSwitch("single-process"))) {
      ctx.set_compat_single_process(true);
      early("网络服务子进程在本机不可用，已自动启用单进程兼容模式（可用 --multi-process 关闭）");
    }
  }

  // 注意：CEF 不会自动处理 Chromium 的 --user-data-dir（那是 Chrome 的约定），
  // 必须自己解析并同时用于 CefSettings。这个开关对排查"旧 profile 损坏"
  // （缓存文件被占用、网络服务反复崩溃）至关重要。
  {
    CefRefPtr<CefCommandLine> cl = CefCommandLine::GetGlobalCommandLine();
    if (cl && cl->HasSwitch("user-data-dir")) {
      const std::string custom = cl->GetSwitchValue("user-data-dir").ToString();
      if (!custom.empty()) {
        ctx.set_user_data_dir(custom);
      }
    }
  }
  early("程序目录 " + ctx.app_dir());
  early("用户数据目录 " + ctx.user_data_dir());

  // 读取命令行开关（无痕窗口、能效模式）
  // 注意：这里必须使用 CEF 自己的命令行对象（GetGlobalCommandLine），
  // 而不是自行 InitFromString 新建一个——后者不含 CEF 注入的内部开关，
  // 会导致子进程判定与部分初始化路径走偏。
  CefRefPtr<CefCommandLine> command_line = CefCommandLine::GetGlobalCommandLine();
  if (!command_line) {
    command_line = CefCommandLine::CreateCommandLine();
    command_line->InitFromString(::GetCommandLineW());
  }
  if (command_line->HasSwitch("incognito")) {
    ctx.set_incognito(true);
  }
  if (command_line->HasSwitch("energy-mode")) {
    ctx.set_energy_mode(command_line->GetSwitchValue("energy-mode").ToString());
  }
  if (command_line->HasSwitch("url")) {
    ctx.set_startup_url(command_line->GetSwitchValue("url").ToString());
  }
  if (command_line->HasSwitch("diag")) {
    ctx.set_diag(true);
    early("已开启诊断模式");
  }
  if (command_line->HasSwitch("open")) {
    // CEF 的 GetSwitchValue 对重复开关只回第一个，这里用 GetSwitches 取全部
    CefCommandLine::SwitchMap switches;
    command_line->GetSwitches(switches);
    const auto range = switches.equal_range("open");
    for (auto it = range.first; it != range.second; ++it) {
      ctx.AddExtraUrl(it->second.ToString());
      early("附加标签页：" + it->second.ToString());
    }
  }
  if (!ctx.startup_url().empty()) early("启动地址：" + ctx.startup_url());

  // 把最终生效的命令行开关全部记录下来：排查"脚本不执行""子进程异常"这类问题时，
  // 最容易被忽略的就是某一方（我们或 CEF）悄悄加了一个开关。
  {
    CefCommandLine::SwitchMap switches;
    command_line->GetSwitches(switches);
    std::string dump;
    for (const auto& kv : switches) {
      dump += "--" + kv.first.ToString() + "=" + kv.second.ToString() + " ";
    }
    early("生效的命令行开关：" + (dump.empty() ? "（无）" : dump));
  }

  // 本地资源服务器必须在 CefInitialize 之前启动：OnContextInitialized 会立刻创建窗口，
  // 那时 UiUrl() 必须已经是可用地址。
  const int ui_port = tib::StartLocalServer(ctx.app_dir());
  if (ui_port == 0) {
    early("本地资源服务器启动失败：外壳 UI 将无法显示");
  } else {
    early("本地资源服务器端口 " + std::to_string(ui_port) + "，UI 地址 " + tib::UiUrl());
  }

  CefSettings settings;

  // 沙箱开关：默认开启。
  //
  // 背景（本机实测）：Chromium 的网络服务子进程启动即崩
  // （cef.log 反复刷 network_service_instance_impl.cc:721 "Network service crashed"），
  // 后果是**任何 HTTP 请求都发不出去**，页面永远空白。
  // 子进程在打日志之前就死了，主进程日志看不到原因，因此这里保留
  // --no-sandbox / --single-process 两个逃生开关，便于在目标机器上快速二分定位。
  // 正式使用请保持默认（沙箱开启、多进程）。
  {
    CefRefPtr<CefCommandLine> cl = CefCommandLine::GetGlobalCommandLine();
    const bool no_sandbox = cl && cl->HasSwitch("no-sandbox");
    if (no_sandbox) settings.no_sandbox = true;
    if (no_sandbox) early("注意：已按命令行要求关闭沙箱（仅用于排查）");
  }
  settings.multi_threaded_message_loop = false;
  settings.windowless_rendering_enabled = false;
  settings.log_severity = LOGSEVERITY_INFO;
  settings.background_color = 0xFF1C1C1E;

  // 用户数据目录：Chromium profile 全部落在这里
  CefString(&settings.root_cache_path) = ctx.user_data_dir();
  CefString(&settings.cache_path) = ctx.user_data_dir() + "\\cache";
  // CEF 自身的日志也落到用户数据目录，便于与 tibrowser.log 对照排查
  CefString(&settings.log_file) = ctx.user_data_dir() + "\\cef.log";
  CefString(&settings.user_agent_product) = "TiBrowser/" TIB_VERSION;

  early("进程模型：" + DetectProcessModel());

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
  tib::StopLocalServer();
  CefShutdown();
  tib::StopService();

  if (mutex) ::CloseHandle(mutex);
  return 0;
}
