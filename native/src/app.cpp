// TiBrowser 应用级对象实现
#include "app.h"

#include "scheme.h"
#include "window.h"

namespace tib {

void TibApp::OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) {
  // tib:// 需要被当作标准协议（有 origin、可被 fetch/XHR 使用），且只在本进程内提供资源
  registrar->AddCustomScheme(
      kSchemeUi,
      CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE | CEF_SCHEME_OPTION_CORS_ENABLED |
          CEF_SCHEME_OPTION_FETCH_ENABLED);
}

void TibApp::OnBeforeCommandLineProcessing(const CefString& process_type,
                                           CefRefPtr<CefCommandLine> command_line) {
  if (!process_type.empty()) return;  // 只处理浏览器进程

  // 能效模式：即开即用/低占用模式下抑制后台活动，把内存让给其他应用
  const std::string energy = AppContext::Get().energy_mode();
  if (energy == "ondemand" || energy == "low") {
    command_line->AppendSwitchWithValue("renderer-process-limit", energy == "ondemand" ? "2" : "4");
    command_line->AppendSwitch("disable-background-timer-throttling");
    command_line->AppendSwitch("disable-features=Translate,BackForwardCache");
  } else if (energy == "fast") {
    command_line->AppendSwitch("enable-features=NetworkServiceInProcess2");
    command_line->AppendSwitchWithValue("renderer-process-limit", "24");
  }

  // 无痕 2.0：第三方 Cookie 默认受限，配合指纹改写降低被追踪面
  command_line->AppendSwitch("disable-features=PrivacySandboxAdsAPIs");

  // Windows 上关闭 GPU 黑名单带来的白屏问题排查入口
  command_line->AppendSwitch("enable-logging");
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
