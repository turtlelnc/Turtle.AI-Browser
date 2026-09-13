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

  // 本机实测：Chromium 的网络服务子进程启动即崩（cef.log 里
  // network_service_instance_impl.cc:721 "Network service crashed" 反复刷屏），
  // 后果是**所有 HTTP 请求都发不出去**，页面永远空白 —— 这是整个白屏问题的真根因。
  // 在查明子进程崩溃原因之前，先把网络服务放进浏览器进程内，保证网络可用。
  command_line->AppendSwitch("enable-features=NetworkServiceInProcess");

  // 能效模式：即开即用/低占用模式下抑制后台活动，把内存让给其他应用
  const std::string energy = AppContext::Get().energy_mode();
  if (energy == "ondemand" || energy == "low") {
    command_line->AppendSwitchWithValue("renderer-process-limit", energy == "ondemand" ? "2" : "4");
    command_line->AppendSwitch("disable-background-timer-throttling");
  } else if (energy == "fast") {
    command_line->AppendSwitchWithValue("renderer-process-limit", "24");
  }

  // 无痕 2.0：第三方 Cookie 默认受限，配合指纹改写降低被追踪面
  command_line->AppendSwitch("disable-features=PrivacySandboxAdsAPIs");
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
