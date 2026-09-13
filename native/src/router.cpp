// 外壳 UI ↔ 原生内核的消息路由：实现 window.tib.* 的查询处理
#include "tib_common.h"
#include "router.h"
#include "scheme.h"
#include "security.h"
#include "service_client.h"
#include "window.h"

#include <algorithm>

namespace tib {

std::string JsonEscape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

bool ParseJson(const std::string& text, CefRefPtr<CefValue>& out) {
  if (text.empty()) {
    out = CefValue::Create();
    return true;
  }
  out = CefParseJSON(text, JSON_PARSER_RFC);
  if (!out) {
    out = CefValue::Create();
    return false;
  }
  return true;
}

std::string GetStringArg(CefRefPtr<CefDictionaryValue> dict, const char* key,
                         const std::string& fallback) {
  if (!dict || !dict->HasKey(key)) return fallback;
  if (dict->GetType(key) != VTYPE_STRING) return fallback;
  return dict->GetString(key).ToString();
}

double GetDoubleArg(CefRefPtr<CefDictionaryValue> dict, const char* key, double fallback) {
  if (!dict || !dict->HasKey(key)) return fallback;
  if (dict->GetType(key) == VTYPE_DOUBLE) return dict->GetDouble(key);
  if (dict->GetType(key) == VTYPE_INT) return static_cast<double>(dict->GetInt(key));
  return fallback;
}

bool GetBoolArg(CefRefPtr<CefDictionaryValue> dict, const char* key, bool fallback) {
  if (!dict || !dict->HasKey(key)) return fallback;
  if (dict->GetType(key) == VTYPE_BOOL) return dict->GetBool(key);
  return fallback;
}

namespace {

/** 路由查询处理器：把 UI 的 tib.* 调用分发到窗口/设置/安全/边车 */
class TibQueryHandler : public CefMessageRouterBrowserSide::Handler {
 public:
  TibQueryHandler() = default;

  bool OnQuery(CefRefPtr<CefBrowser> browser,
               CefRefPtr<CefFrame> frame,
               int64_t query_id,
               const CefString& request,
               bool persistent,
               CefRefPtr<Callback> callback) override {
    CefRefPtr<CefValue> payload;
    ParseJson(request.ToString(), payload);
    CefRefPtr<CefDictionaryValue> dict =
        payload && payload->GetType() == VTYPE_DICTIONARY ? payload->GetDictionary() : nullptr;
    const std::string method = GetStringArg(dict, "method", "");
    CefRefPtr<CefValue> params =
        dict && dict->HasKey("params") && dict->GetType("params") == VTYPE_DICTIONARY
            ? dict->GetValue("params")
            : CefValue::Create();
    CefRefPtr<CefDictionaryValue> args =
        params->GetType() == VTYPE_DICTIONARY ? params->GetDictionary() : nullptr;

    TibWindow* window = WindowForBrowser(browser);
    const std::string result = Dispatch(window, method, args);
    callback->Success(result);
    return true;
  }

  void OnQueryCanceled(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       int64_t query_id) override {}

 private:
  static TibWindow* WindowForBrowser(CefRefPtr<CefBrowser> browser);
  static std::string Ok(const std::string& extra_json = "");
  static std::string Err(const std::string& message);
  std::string Dispatch(TibWindow* window, const std::string& method,
                       CefRefPtr<CefDictionaryValue> args);
};

TibWindow* TibQueryHandler::WindowForBrowser(CefRefPtr<CefBrowser> browser) {
  return FindWindowByChromeBrowser(browser);
}

std::string TibQueryHandler::Ok(const std::string& extra_json) {
  if (extra_json.empty()) return "{\"ok\":true}";
  // 支持 {"ok":true, ...} 形态：把 extra 作为额外字段拼进去
  if (extra_json[0] == '{') {
    std::string body = extra_json.substr(1, extra_json.size() - 2);
    if (body.empty()) return "{\"ok\":true}";
    return "{\"ok\":true," + body + "}";
  }
  return "{\"ok\":true,\"result\":" + extra_json + "}";
}

std::string TibQueryHandler::Err(const std::string& message) {
  return "{\"ok\":false,\"error\":{\"code\":\"E_TIB\",\"message\":\"" + JsonEscape(message) + "\"}}";
}

std::string TibQueryHandler::Dispatch(TibWindow* window, const std::string& method,
                                      CefRefPtr<CefDictionaryValue> args) {
  if (method.empty()) return Err("缺少 method 参数");
  AppContext& ctx = AppContext::Get();

  // ---- 不需要窗口的调用 ----
  if (method == "app.info") {
    return Ok("{\"name\":\"" TIB_PRODUCT_NAME "\",\"version\":\"" TIB_VERSION
              "\",\"build\":\"" TIB_BUILD "\",\"chromium\":\"" CEF_VERSION "\"}");
  }
  if (method == "settings.get") {
    return Ok("{\"protectionLevel\":\"" + ctx.protection_level() + "\",\"energyMode\":\"" +
              ctx.energy_mode() + "\",\"skin\":\"" + ctx.skin() + "\"}");
  }
  if (method == "settings.setProtectionLevel") {
    const std::string level = GetStringArg(args, "level", "standard");
    if (level != "enhanced" && level != "standard" && level != "none")
      return Err("未知的安全浏览档位：" + level);
    ctx.set_protection_level(level);
    if (window) window->SyncState();
    return Ok("{\"protectionLevel\":\"" + level + "\"}");
  }
  if (method == "settings.setSkin") {
    const std::string skin = GetStringArg(args, "skin", "tibrowser");
    if (skin != "tibrowser" && skin != "edge" && skin != "chrome")
      return Err("未知的界面皮肤：" + skin);
    ctx.set_skin(skin);
    if (window) window->SyncState();
    return Ok("{\"skin\":\"" + skin + "\"}");
  }
  if (method == "settings.setEnergyMode") {
    const std::string mode = GetStringArg(args, "mode", "standard");
    if (mode != "standard" && mode != "fast" && mode != "low" && mode != "ondemand")
      return Err("未知的能效模式：" + mode);
    ctx.set_energy_mode(mode);
    if (window) window->SyncState();
    // 能效模式中「快速模式」在部分设备上不可用：此处如实回报是否需要重启生效
    const bool needs_restart = true;
    return Ok("{\"energyMode\":\"" + mode + "\",\"applied\":false,\"needsRestart\":" +
              (needs_restart ? "true" : "false") + "}");
  }
  if (method == "security.scan") {
    const ScanResult r = ScanUrlForProtection(GetStringArg(args, "url", ""));
    return Ok("{\"blocked\":" + std::string(r.blocked ? "true" : "false") +
              ",\"trusted\":" + std::string(r.trusted ? "true" : "false") + ",\"category\":\"" +
              JsonEscape(r.category) + "\",\"reason\":\"" + JsonEscape(r.reason) +
              "\",\"action\":\"" + JsonEscape(r.action) + "\"}");
  }
  if (method == "service.status") return Ok(ServiceStatusJson());
  if (method == "automation.info") return Ok(AutomationInfoJson());

  // ---- 需要窗口的调用 ----
  if (!window) return Err("没有可操作的窗口");

  if (method == "tabs.new") {
    const std::string id = window->CreateTab(GetStringArg(args, "url", ""), true);
    return Ok("{\"tabId\":\"" + JsonEscape(id) + "\"}");
  }
  if (method == "tabs.close") {
    window->CloseTab(GetStringArg(args, "tabId", ""));
    return Ok();
  }
  if (method == "tabs.activate") {
    window->ActivateTab(GetStringArg(args, "tabId", ""));
    return Ok();
  }
  if (method == "tabs.move") {
    window->MoveTab(GetStringArg(args, "tabId", ""),
                    static_cast<int>(GetDoubleArg(args, "index", 0)));
    return Ok();
  }
  if (method == "nav.go") {
    window->Navigate(GetStringArg(args, "input", ""));
    return Ok();
  }
  if (method == "nav.back") { window->GoBack(); return Ok(); }
  if (method == "nav.forward") { window->GoForward(); return Ok(); }
  if (method == "nav.reload") { window->Reload(GetBoolArg(args, "ignoreCache", false)); return Ok(); }
  if (method == "nav.stop") { window->Stop(); return Ok(); }
  if (method == "view.zoom") {
    window->SetZoom(GetDoubleArg(args, "level", 0));
    return Ok();
  }
  if (method == "view.devtools") { window->ToggleDevTools(); return Ok(); }
  if (method == "window.close") { window->Close(); return Ok(); }

  return Err("未知的方法：" + method);
}

}  // namespace

// ---------------------------------------------------------------- 窗口查找

namespace {
std::vector<std::pair<CefRefPtr<CefBrowser>, TibWindow*>>& WindowRegistry() {
  static std::vector<std::pair<CefRefPtr<CefBrowser>, TibWindow*>> registry;
  return registry;
}
}  // namespace

void RegisterWindowForChromeBrowser(CefRefPtr<CefBrowser> browser, TibWindow* window) {
  if (!browser) return;
  auto& reg = WindowRegistry();
  reg.erase(std::remove_if(reg.begin(), reg.end(),
                           [&](const std::pair<CefRefPtr<CefBrowser>, TibWindow*>& p) {
                             return p.first->IsSame(browser);
                           }),
            reg.end());
  reg.emplace_back(browser, window);
}

void UnregisterWindow(TibWindow* window) {
  auto& reg = WindowRegistry();
  reg.erase(std::remove_if(reg.begin(), reg.end(),
                           [&](const std::pair<CefRefPtr<CefBrowser>, TibWindow*>& p) {
                             return p.second == window;
                           }),
            reg.end());
}

TibWindow* FindWindowByChromeBrowser(CefRefPtr<CefBrowser> browser) {
  if (!browser) return nullptr;
  for (auto& entry : WindowRegistry()) {
    if (entry.first && entry.first->IsSame(browser)) return entry.second;
  }
  return nullptr;
}

CefRefPtr<CefMessageRouterBrowserSide> CreateTibRouter() {
  CefMessageRouterConfig config;
  config.js_query_function = "tibQuery";
  config.js_cancel_function = "tibQueryCancel";
  return CefMessageRouterBrowserSide::Create(config);
}

CefMessageRouterBrowserSide::Handler* CreateTibQueryHandler() {
  return new TibQueryHandler();
}

}  // namespace tib
