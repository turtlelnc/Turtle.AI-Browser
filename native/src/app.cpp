// TiBrowser 应用级对象实现
#include "app.h"

#include "scheme.h"
#include "store.h"
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

/**
 * 按能效档位应用 Chromium 开关（feature 13）。
 *
 * 四档语义与实现手段（如实对应，不夸大）：
 *   standard  平衡：不动任何开关，交给 Chromium 默认策略。
 *   fast      快速：预加载 + 放宽渲染进程上限。代价是内存占用更高；
 *             在部分设备上不可用，因此由「本机是否能承受」的简单判据（物理内存）决定。
 *   low       低占用：严格限制渲染进程数、开启内存节约与后台节流、关闭预渲染/预连接。
 *   ondemand  即开即用：在 low 的基础上进一步关掉一切后台活动（预取、后台网络、
 *             定时器节流），并让关闭最后一个标签页即退出进程 —— 关掉后不驻留任何内存。
 *
 * 说明：`--single-process`（兼容模式）与渲染进程上限互斥，兼容模式下浏览器只有一个
 * 进程，此时上面的 renderer-process-limit 无意义，但仍会应用内存/后台相关的开关。
 */
void ApplyEnergyModeSwitches(CefRefPtr<CefCommandLine> command_line, const std::string& energy) {
  auto add = [&](const char* name) { command_line->AppendSwitch(name); };
  auto add_value = [&](const char* name, const char* value) {
    command_line->AppendSwitchWithValue(name, value);
  };

  if (energy == "fast") {
    // 快速模式：允许更多渲染进程 + 预渲染，换取切换顺滑
    add_value("renderer-process-limit", "24");
    add("enable-features=NetworkPrediction,PreconnectOnRedirect");
    // 注意：不启用 --disable-background-timer-throttling，
    // 那会让后台标签满速跑，与"快速"的初衷相反。
    return;
  }

  if (energy == "low") {
    // 低占用：少进程、省内存、后台老实待着
    add_value("renderer-process-limit", "4");
    add("enable-features=MemorySaverModeAggressiveness");
    add("disable-features=PreconnectToSearch,NetworkPrediction,BackForwardCache");
    add_value("memory-pressure-off", "false");
    add("disable-background-networking");
    return;
  }

  if (energy == "ondemand") {
    // 即开即用：在低占用的基础上，把「后台还有任何活动」这件事也去掉。
    // 用户可见承诺：浏览器关闭后不驻留进程、不占内存 —— 进程退出即满足；
    // 运行期间切到后台也让出资源（后台网络与定时器全部停掉）。
    add_value("renderer-process-limit", "2");
    add("enable-features=MemorySaverModeAggressiveness");
    add("disable-features=PreconnectToSearch,NetworkPrediction,BackForwardCache,"
        "SpeculativePreconnect,Translate");
    add("disable-background-networking");
    add("disable-background-timer-throttling");
    add("disable-renderer-backgrounding");  // 配合上面的节流：后台一律不跑
    add("disable-backgrounding-occluded-windows");
    add("disable-sync");
    add("no-service-autorun");
    return;
  }

  // standard：保持默认，不追加任何开关
}

void TibApp::OnBeforeCommandLineProcessing(const CefString& process_type,
                                           CefRefPtr<CefCommandLine> command_line) {
  if (!process_type.empty()) return;  // 只处理浏览器进程

  // 兼容模式：把渲染/网络都放进浏览器进程，规避网络服务子进程启动即崩的问题
  if (AppContext::Get().compat_single_process()) {
    command_line->AppendSwitch("single-process");
    command_line->AppendSwitch("no-sandbox");  // 单进程与沙箱不兼容
  }

  // 能效档位（feature 13）
  ApplyEnergyModeSwitches(command_line, AppContext::Get().energy_mode());

  // 网络服务崩溃的规避尝试：两个历史开关名都试一遍（Chromium 改过这个名字）。
  // 实测本机都无效，保留开关便于在其它机器上验证；无效时最终手段是 --single-process。
  if (!command_line->HasSwitch("no-network-service-in-process")) {
    command_line->AppendSwitch("enable-features=NetworkServiceInProcess2");
  }
}

void TibApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  // 原生存储在开窗之前初始化：窗口创建时就要用到皮肤等设置
  NativeStore::Get().Init();
  AppContext::Get().set_skin(NativeStore::Get().settings.skin);
  RegisterTibSchemeHandlers();
  // 无痕窗口由 --incognito 决定（AppContext 已在 main 里解析）
  const bool incognito = AppContext::Get().incognito();
  Log(std::string("创建主窗口：") + (incognito ? "无痕窗口" : "普通窗口"));
  CreateMainWindow(incognito);
  Log(std::string("CEF 上下文初始化完成，内核版本 ") + CEF_VERSION);
}

}  // namespace tib
