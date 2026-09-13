// TiBrowser 应用级对象：CEF 初始化、子进程分发、外壳 UI 的协议注册
#pragma once

#include "tib_common.h"

namespace tib {

/** CefApp 实现：同时承担浏览器进程回调（OnContextInitialized / 命令行处理） */
class TibApp : public CefApp, public CefBrowserProcessHandler {
 public:
  TibApp() = default;

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }

  void OnBeforeCommandLineProcessing(const CefString& process_type,
                                     CefRefPtr<CefCommandLine> command_line) override;

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override;

 private:
  IMPLEMENT_REFCOUNTING(TibApp);
};

}  // namespace tib
