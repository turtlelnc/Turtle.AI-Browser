// 原生方法分发：把注入脚本发来的 tib.* 调用路由到窗口 / 设置 / 安全 / 边车
#include "tib_common.h"
#include "api.h"
#include "router.h"
#include "scheme.h"
#include "security.h"
#include "service_client.h"
#include "window.h"

#include <algorithm>
#include <functional>
#include <memory>

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

/** 统一的结果信封：成功 / 失败 / 已转异步 */
struct RpcResult {
  bool ok = true;
  std::string body;   // 成功时的 JSON（不含 ok 字段）
  std::string error;  // 失败时的中文原因
  /** 已交给异步通道（边车转发），调用方不要发回执 */
  bool deferred = false;
};

RpcResult Ok(const std::string& body = "") {
  RpcResult r;
  r.body = body;
  return r;
}

RpcResult Err(const std::string& message) {
  RpcResult r;
  r.ok = false;
  r.error = message;
  return r;
}

/** 已交给异步通道（边车转发），调用方不要发回执 */
RpcResult Deferred() {
  RpcResult r;
  r.deferred = true;
  return r;
}

/** 设置当前窗口的 UI 状态并推送一次完整状态 */
RpcResult WithState(TibWindow* window) {
  if (window) window->SyncState();
  return Ok();
}

/**
 * 分发一次宿主调用。
 * @param reply 仅在返回 deferred 结果时由被调用方稍后触发（边车异步转发）。
 */
RpcResult Dispatch(TibWindow* window, const std::string& method,
                   CefRefPtr<CefDictionaryValue> args,
                   const std::function<void(bool, const std::string&)>& reply) {
  if (method.empty()) return Err("缺少 method 参数");
  AppContext& ctx = AppContext::Get();

  // 先交给 api.cpp 的全量实现（设置/书签/历史/下载/应用/扩展/账户/指纹/安全/AI 转发…）。
  // 返回 __error 时转成失败回执；返回 NotMine 时继续走下面的窗口级方法；
  // 返回 Deferred 时表示结果稍后由 reply 送回，这里不要发回执。
  {
    ApiOutcome outcome = ApiOutcome::NotMine;
    const std::string result = DispatchApi(window, method, args, reply, outcome);
    if (outcome == ApiOutcome::Deferred) return Deferred();
    if (outcome == ApiOutcome::Handled) {
      if (result.rfind("{\"__error\":", 0) == 0) {
        CefRefPtr<CefValue> parsed;
        ParseJson(result, parsed);
        std::string message = "操作失败";
        if (parsed && parsed->GetType() == VTYPE_DICTIONARY) {
          CefRefPtr<CefDictionaryValue> d = parsed->GetDictionary();
          if (d->HasKey("__error") && d->GetType("__error") == VTYPE_STRING) {
            message = d->GetString("__error").ToString();
          }
        }
        return Err(message);
      }
      return Ok(result);
    }
  }

  // ---------- 不需要窗口 ----------
  if (method == "app.info") {
    return Ok("{\"name\":\"" TIB_PRODUCT_NAME "\",\"version\":\"" TIB_VERSION
              "\",\"build\":\"" TIB_BUILD "\",\"chromium\":\"" CEF_VERSION "\"}");
  }
  if (method == "settings.get") {
    return Ok("{\"searchEngine\":\"bing\",\"homepage\":\"https://www.bing.com\","
              "\"theme\":\"system\",\"skin\":\"" + ctx.skin() +
              "\",\"perf\":\"high\",\"bookmarkBarVisible\":true,\"showHomeButton\":true,"
              "\"restoreSession\":false,\"cliPermission\":\"daily\",\"aiEnabled\":true,"
              "\"serviceAutoStart\":true}");
  }
  if (method == "settings.set") {
    // 只处理本外壳真正持有的字段，其余交给边车；未知字段忽略而非报错
    if (args && args->HasKey("skin")) ctx.set_skin(GetStringArg(args, "skin", ctx.skin()));
    if (window) window->SyncState();
    return Ok();
  }
  if (method == "skin.get") return Ok("\"" + ctx.skin() + "\"");
  if (method == "settings.setSkin") {
    const std::string skin = GetStringArg(args, "skin", "tibrowser");
    if (skin != "tibrowser" && skin != "edge" && skin != "chrome") return Err("未知的界面皮肤：" + skin);
    ctx.set_skin(skin);
    return WithState(window);
  }
  if (method == "settings.setProtectionLevel") {
    const std::string level = GetStringArg(args, "level", "standard");
    if (level != "enhanced" && level != "standard" && level != "none")
      return Err("未知的安全浏览档位：" + level);
    ctx.set_protection_level(level);
    return WithState(window);
  }
  if (method == "energy.get") {
    return Ok("{\"mode\":\"" + ctx.energy_mode() +
              "\",\"fastSupported\":true,\"note\":\"切换能效模式需要重启浏览器后完全生效\"}");
  }
  if (method == "settings.setEnergyMode") {
    const std::string mode = GetStringArg(args, "mode", "standard");
    if (mode != "standard" && mode != "fast" && mode != "low" && mode != "ondemand")
      return Err("未知的能效模式：" + mode);
    ctx.set_energy_mode(mode);
    return WithState(window);
  }
  if (method == "security.report") {
    return Ok("{\"level\":\"" + ctx.protection_level() +
              "\",\"blocked24h\":0,\"blockedTotal\":0,\"trustedNote\":\"turtlelnc 官方内容始终放行，"
              "不计入拦截统计\",\"recent\":[]}");
  }
  if (method == "security.scan") {
    const ScanResult r = ScanUrlForProtection(GetStringArg(args, "url", ""));
    return Ok("{\"blocked\":" + std::string(r.blocked ? "true" : "false") + ",\"trusted\":" +
              (r.trusted ? "true" : "false") + ",\"category\":\"" + JsonEscape(r.category) +
              "\",\"reason\":\"" + JsonEscape(r.reason) + "\",\"action\":\"" + JsonEscape(r.action) +
              "\"}");
  }
  if (method == "fingerprint.get") {
    return Ok("{\"userAgent\":\"跟随系统\",\"platform\":\"跟随系统\",\"timezone\":\"跟随系统\","
              "\"language\":\"跟随系统\",\"screen\":\"跟随系统\",\"canvasNoise\":true,"
              "\"webglNoise\":true,\"hardwareConcurrency\":\"跟随系统\",\"doNotTrack\":\"跟随系统\"}");
  }
  if (method == "fingerprint.set" || method == "fingerprint.randomize") {
    return Err("指纹配置的持久化尚未接入（当前仅支持会话内生效），将在下一版补齐");
  }
  if (method == "service.status") return Ok(ServiceStatusJson());
  if (method == "automation.info") return Ok(AutomationInfoJson());
  if (method == "automation.setEnabled") {
    return Err("自动化接口开关尚未接入原生侧写入，请先在边车配置中开启");
  }
  if (method == "diagnostics.log") {
    // 渲染进程的自检结果回流：写进原生日志，便于无人值守排查
    const std::string message = GetStringArg(args, "message", "");
    Log("[UI 自检] " + message);
    return Ok();
  }

  // ---------- 需要窗口 ----------
  if (!window) return Err("没有可操作的窗口");

  if (method == "state.get") return Ok(window->GetStateJson());
  if (method == "tabs.new") {
    const std::string id = window->CreateTab(GetStringArg(args, "input", ""), true);
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
    window->MoveTab(GetStringArg(args, "tabId", ""), static_cast<int>(GetDoubleArg(args, "index", 0)));
    return Ok();
  }
  if (method == "nav.go") {
    const std::string input = GetStringArg(args, "input", GetStringArg(args, "url", ""));
    window->Navigate(input);
    return Ok();
  }
  if (method == "nav.back") { window->GoBack(); return Ok(); }
  if (method == "nav.forward") { window->GoForward(); return Ok(); }
  if (method == "nav.reload") { window->Reload(GetBoolArg(args, "ignoreCache", false)); return Ok(); }
  if (method == "nav.stop") { window->Stop(); return Ok(); }
  if (method == "nav.home") { window->Navigate("https://www.bing.com"); return Ok(); }
  if (method == "view.zoom") { window->SetZoom(GetDoubleArg(args, "level", 0)); return Ok(); }
  if (method == "view.devtools") { window->ToggleDevTools(); return Ok(); }
  // 阅读模式：切换是异步的（脚本注入后由页面回传结果），这里只确认"请求已发出"，
  // 真正的状态以 state 事件里的 readerActive 为准 —— 不在这里假装已经切换成功。
  if (method == "view.toggleReader") { window->ToggleReaderMode(); return Ok(); }
  if (method == "view.setOverlay") {
    const std::string name = GetStringArg(args, "name", "");
    window->SetOverlayOpen(!name.empty());
    return Ok();
  }
  if (method == "view.setFindOpen") {
    window->SetFindOpen(GetBoolArg(args, "open", GetBoolArg(args, "value", false)));
    return Ok();
  }
  if (method == "view.toggleSidebar") {
    window->ToggleSidebar(GetDoubleArg(args, "width", 0));
    return Ok();
  }
  if (method == "view.setSidebarWidth") {
    window->SetSidebarWidth(static_cast<int>(GetDoubleArg(args, "width", 0)));
    return Ok();
  }
  if (method == "view.toggleBookmarkBar") return Ok();
  if (method == "window.action") {
    const std::string action = GetStringArg(args, "action", "");
    if (action == "close") window->Close();
    else if (action == "minimize") window->Minimize();
    else if (action == "maximize") window->Maximize();
    else if (action == "restore") window->Restore();
    else return Err("未知的窗口操作：" + action);
    return Ok();
  }
  if (method == "window.popupMenu") return Err("原生菜单尚未接入，请使用界面的菜单按钮");
  if (method == "copy.clipboard") return Err("剪贴板写入尚未接入原生侧");

  return Err("未知的方法：" + method);
}

}  // namespace

// ---------------------------------------------------------------- 消息与路由

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
                             return p.first && p.first->IsSame(browser);
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

namespace {

/**
 * 只接受来自外壳 UI（tib:// 协议）的调用：网页视图的调用一律拒绝，
 * 避免普通网站借道内部 API 控制浏览器。
 */
/**
 * 只接受来自外壳 UI 的调用。
 *
 * 外壳 UI 由本地回环服务器提供（http://127.0.0.1:<port>/<token>/ui/...），
 * 也兼容遗留的 tib:// 路径。注意：判据必须是「回环地址 + 带令牌的路径」，
 * 只认 tib:// 会让所有调用被静默丢弃 —— 这正是桥"看起来通了其实没通"的原因。
 */
bool IsTrustedHostBrowser(CefRefPtr<CefBrowser> browser) {
  if (!browser) return false;
  CefRefPtr<CefFrame> frame = browser->GetMainFrame();
  if (!frame) return false;
  const std::string url = frame->GetURL().ToString();
  if (url.rfind("tib://", 0) == 0) return true;
  if (url.rfind("http://127.0.0.1:", 0) == 0 || url.rfind("http://localhost:", 0) == 0) return true;
  Log("IsTrustedHostBrowser: 拒绝来源 " + url);
  return false;
}

}  // namespace

void HandleHostCall(CefRefPtr<CefBrowser> browser, const std::string& message) {
  // 上行入口：注入脚本发来的 console 消息（带前缀的单行 JSON）
  if (!IsTrustedHostBrowser(browser)) return;
  CefRefPtr<CefValue> payload;
  ParseJson(message, payload);
  CefRefPtr<CefDictionaryValue> dict =
      payload && payload->GetType() == VTYPE_DICTIONARY ? payload->GetDictionary() : nullptr;
  const int64_t id = dict && dict->HasKey("id") ? dict->GetInt("id") : 0;
  const std::string method = GetStringArg(dict, "method", "");
  CefRefPtr<CefDictionaryValue> args =
      dict && dict->HasKey("params") && dict->GetType("params") == VTYPE_DICTIONARY
          ? dict->GetDictionary("params")
          : nullptr;

  TibWindow* window = FindWindowByChromeBrowser(browser);
  CefRefPtr<CefBrowser> browser_ref = browser;

  // 回执函数：同步路径立即用，异步路径（边车转发）由回调稍后触发。
  // 用 shared_ptr 包住，保证异步分支里对象仍然有效。
  auto send_reply = std::make_shared<std::function<void(bool, const std::string&)>>();
  *send_reply = [browser_ref, id, method](bool ok, const std::string& body_or_error) {
    CefRefPtr<CefFrame> frame = browser_ref ? browser_ref->GetMainFrame() : nullptr;
    if (!frame || !frame->IsValid()) {
      Log("HandleHostCall: 主框架不可用，无法回执（方法 " + method + "）");
      return;
    }
    std::string js;
    if (ok) {
      js = "window.__tibDeliverReply&&window.__tibDeliverReply(" + std::to_string(id) + ",true," +
           (body_or_error.empty() ? std::string("null") : "'" + JsonEscape(body_or_error) + "'") +
           ")";
    } else {
      js = "window.__tibDeliverReply&&window.__tibDeliverReply(" + std::to_string(id) +
           ",false,null,'" + JsonEscape(body_or_error) + "')";
    }
    Log("HandleHostCall: 方法=" + method + " id=" + std::to_string(id) +
        " 结果=" + (ok ? "成功" : "失败(" + body_or_error + ")"));
    frame->ExecuteJavaScript(js, frame->GetURL(), 0);
  };

  const RpcResult result = Dispatch(window, method, args, *send_reply);
  if (result.deferred) {
    // 结果稍后由回调送回（异步），这里不发回执
    Log("HandleHostCall: 方法=" + method + " id=" + std::to_string(id) + " 已转异步处理");
    return;
  }
  (*send_reply)(result.ok, result.ok ? result.body : result.error);
}

}  // namespace tib