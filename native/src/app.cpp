// TiBrowser 应用级对象实现
#include "app.h"

#include "scheme.h"
#include <cstdio>

#include "window.h"

namespace tib {

void TibApp::OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) {
  // tib:// 需要被当作标准协议（有 origin、可被 fetch/XHR 使用），且只在本进程内提供资源
  const int options = CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE |
                      CEF_SCHEME_OPTION_CORS_ENABLED | CEF_SCHEME_OPTION_FETCH_ENABLED;
  const bool ok = registrar->AddCustomScheme(kSchemeUi, options);
  // 这一步失败（返回 false）会导致后续所有 tib:// 请求报 ERR_UNKNOWN_URL_SCHEME，
  // 而 CEF 不会给出更明确的提示，所以必须显式记录。
  char buf[128];
  snprintf(buf, sizeof(buf), "OnRegisterCustomSchemes: AddCustomScheme(tib, %d) = %s", options,
           ok ? "true" : "false");
  Log(buf);
}

void TibApp::OnBeforeCommandLineProcessing(const CefString& process_type,
                                           CefRefPtr<CefCommandLine> command_line) {
  if (!process_type.empty()) return;  // 只处理浏览器进程

  // 兼容模式：把渲染/网络都放进浏览器进程，规避网络服务子进程启动即崩的问题
  if (AppContext::Get().compat_single_process()) {
    command_line->AppendSwitch("single-process");
    command_line->AppendSwitch("no-sandbox");  // 单进程与沙箱不兼容
  }

  // 本机实测：Chromium 的网络服务子进程启动即崩
  // （cef.log 反复刷 network_service_instance_impl.cc:721 "Network service crashed"），
  // 后果是**所有 HTTP 请求都发不出去**，页面永远空白 —— 这是白屏问题的真根因。
  // 子进程在打日志之前就死了，因此这里不擅自关闭/改写任何会影响子进程启动的开关，
  // 由命令行显式控制（见 docs/STATUS.md §3.1）。
  const std::string energy = AppContext::Get().energy_mode();
  if (energy == "ondemand" || energy == "low") {
    command_line->AppendSwitchWithValue("renderer-process-limit", energy == "ondemand" ? "2" : "4");
  } else if (energy == "fast") {
    command_line->AppendSwitchWithValue("renderer-process-limit", "24");
  }

  // 网络服务崩溃的规避尝试：两个历史开关名都试一遍（Chromium 改过这个名字）。
  // 实测本机都无效，保留开关便于在其它机器上验证；无效时最终手段是 --single-process。
  if (!command_line->HasSwitch("no-network-service-in-process")) {
    command_line->AppendSwitch("enable-features=NetworkServiceInProcess2");
  }
}

void TibApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  Log("OnContextInitialized: 开始注册 tib:// 协议");
  RegisterTibSchemeHandlers();
  Log("OnContextInitialized: 协议注册完成，创建主窗口");
  CreateMainWindow(false);
  Log(std::string("CEF 上下文初始化完成，内核版本 ") + CEF_VERSION);
}

}  // namespace tib
