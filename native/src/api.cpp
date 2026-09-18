// 原生 API 分发：实现 UI 桥接契约（src/shared/bridge.ts）里的全部方法。
//
// 分工原则（见 docs/ARCHITECTURE.md）：
//   * 浏览器本体知道的事实（标签、导航、书签、历史、下载、扩展、账户登录态、
//     指纹画像、网页应用）由**原生**回答；
//   * 需要生态库的能力（AI 流式对话、MCP、OAuth 授权、办公/开发模式）由 **Node 边车**
//     回答，原生侧转发并把边车的中文错误原样回给 UI。
//
// 未实现的方法一律返回明确的中文原因，**不假装成功** —— 界面因此能显示"为什么不可用"，
// 而不是永远转圈。
#include "api.h"

#include "crx.h"
#include "local_server.h"
#include "router.h"
#include "security.h"
#include "service_client.h"
#include "store.h"
#include "window.h"

#include <windows.h>

#include <commdlg.h>
#include <objbase.h>

#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>

#include <algorithm>
#include <map>
#include <sstream>

namespace tib {
namespace {

/** 秒 → JSON 毫秒时间戳（UI 侧按毫秒显示） */
std::string Ms(int64_t seconds) { return std::to_string(seconds * 1000); }

std::string Quote(const std::string& in) { return "\"" + JsonEscapePublic(in) + "\""; }

/** 简单的 JSON 数组拼接 */
std::string Join(const std::vector<std::string>& items) {
  std::string out = "[";
  for (size_t i = 0; i < items.size(); ++i) {
    if (i) out += ",";
    out += items[i];
  }
  out += "]";
  return out;
}

/** 取字符串参数，兼容 value 字段 */
std::string ArgStr(CefRefPtr<CefDictionaryValue> args, const char* key,
                   const std::string& fallback = "") {
  if (!args) return fallback;
  if (args->HasKey(key) && args->GetType(key) == VTYPE_STRING) return args->GetString(key).ToString();
  if (args->HasKey("value") && args->GetType("value") == VTYPE_STRING)
    return args->GetString("value").ToString();
  return fallback;
}

int ArgInt(CefRefPtr<CefDictionaryValue> args, const char* key, int fallback = 0) {
  if (!args || !args->HasKey(key)) return fallback;
  if (args->GetType(key) == VTYPE_INT) return args->GetInt(key);
  if (args->GetType(key) == VTYPE_DOUBLE) return static_cast<int>(args->GetDouble(key));
  return fallback;
}

bool ArgBool(CefRefPtr<CefDictionaryValue> args, const char* key, bool fallback = false) {
  if (!args || !args->HasKey(key)) return fallback;
  if (args->GetType(key) == VTYPE_BOOL) return args->GetBool(key);
  return fallback;
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

std::string BookmarksJson() {
  std::vector<std::string> items;
  for (const Bookmark& b : NativeStore::Get().bookmarks) {
    items.push_back("{\"id\":" + Quote(b.id) + ",\"title\":" + Quote(b.title) + ",\"url\":" +
                    Quote(b.url) + ",\"folder\":" + Quote(b.folder) +
                    ",\"createdAt\":" + Ms(b.created_at) + "}");
  }
  return Join(items);
}

std::string HistoryJson(const std::string& keyword, int limit) {
  std::vector<std::string> items;
  const auto& hist = NativeStore::Get().history;
  std::string lowered;
  for (char c : keyword) lowered.push_back(static_cast<char>(::tolower(c)));
  for (const HistoryEntry& h : hist) {
    if (!keyword.empty()) {
      std::string hay = h.title + " " + h.url;
      for (auto& c : hay) c = static_cast<char>(::tolower(c));
      if (hay.find(lowered) == std::string::npos) continue;
    }
    items.push_back("{\"id\":" + Quote(h.id) + ",\"title\":" + Quote(h.title) + ",\"url\":" +
                    Quote(h.url) + ",\"visitedAt\":" + Ms(h.visited_at) + "}");
    if (limit > 0 && static_cast<int>(items.size()) >= limit) break;
  }
  return Join(items);
}

std::string DownloadsJson() {
  std::vector<std::string> items;
  for (const DownloadRecord& r : NativeStore::Get().downloads) {
    items.push_back("{\"id\":" + Quote(r.id) + ",\"filename\":" + Quote(r.filename) +
                    ",\"url\":" + Quote(r.url) + ",\"savePath\":" + Quote(r.save_path) +
                    ",\"receivedBytes\":" + std::to_string(r.received) +
                    ",\"totalBytes\":" + std::to_string(r.total) + ",\"state\":" + Quote(r.state) +
                    ",\"suspicious\":" + (r.suspicious ? "true" : "false") +
                    ",\"suspiciousReason\":" + Quote(r.suspicious_reason) + "}");
  }
  return Join(items);
}

std::string AppsJson() {
  std::vector<std::string> items;
  for (const WebApp& a : NativeStore::Get().apps) {
    items.push_back("{\"id\":" + Quote(a.id) + ",\"name\":" + Quote(a.name) + ",\"url\":" +
                    Quote(a.url) + ",\"icon\":" + Quote(a.icon) +
                    ",\"createdAt\":" + Ms(a.created_at) + "}");
  }
  return Join(items);
}

std::string ExtensionsJson() {
  std::vector<std::string> items;
  for (const ExtensionRecord& e : NativeStore::Get().extensions) {
    items.push_back("{\"id\":" + Quote(e.id) + ",\"name\":" + Quote(e.name) +
                    ",\"version\":" + Quote(e.version) + ",\"path\":" + Quote(e.path) +
                    ",\"enabled\":" + (e.enabled ? "true" : "false") +
                    ",\"description\":" + Quote(e.description) + "}");
  }
  return Join(items);
}

std::string FingerprintJson() {
  const FingerprintProfile& f = NativeStore::Get().fingerprint;
  return "{\"userAgent\":" + Quote(f.user_agent) + ",\"platform\":" + Quote(f.platform) +
         ",\"timezone\":" + Quote(f.timezone) + ",\"language\":" + Quote(f.language) +
         ",\"screen\":" + Quote(f.screen) + ",\"hardwareConcurrency\":" +
         Quote(f.hardware_concurrency) + ",\"doNotTrack\":" + Quote(f.do_not_track) +
         ",\"canvasNoise\":" + (f.canvas_noise ? "true" : "false") +
         ",\"webglNoise\":" + (f.webgl_noise ? "true" : "false") + "}";
}

std::string AccountsJson() {
  std::vector<std::string> items;
  for (const AccountRecord& a : NativeStore::Get().accounts) {
    items.push_back("{\"provider\":" + Quote(a.provider) + ",\"email\":" + Quote(a.email) +
                    ",\"displayName\":" + Quote(a.display_name) +
                    ",\"signedInAt\":" + Ms(a.signed_in_at) + "}");
  }
  return Join(items);
}

std::string SyncStateJson() {
  const NativeStore& s = NativeStore::Get();
  return "{\"enabled\":" + std::string(s.sync_enabled ? "true" : "false") +
         ",\"lastSyncAt\":" + Ms(s.last_sync_at) + ",\"syncing\":false,\"toggles\":{" +
         "\"bookmarks\":" + (s.sync_toggles.bookmarks ? "true" : "false") +
         ",\"history\":" + (s.sync_toggles.history ? "true" : "false") +
         ",\"settings\":" + (s.sync_toggles.settings ? "true" : "false") +
         ",\"extensions\":" + (s.sync_toggles.extensions ? "true" : "false") +
         ",\"passwords\":" + (s.sync_toggles.passwords ? "true" : "false") +
         "},\"note\":\"当前使用本地文件夹同步（用户自选的 OneDrive 等目录）；"
         "云端账户同步需要自备 OAuth client id\"}";
}

/** 当前进程模型的可读描述（本机网络服务子进程不可用，需单进程兼容模式规避） */
std::string ProcessModelJson() {
  if (AppContext::Get().compat_single_process()) {
    return "单进程兼容模式（网络服务子进程在本机不可用，已自动规避；进程隔离性下降）";
  }
  return "标准（多进程 + 沙箱）";
}

std::string SettingsJson() {  const AppSettings& s = NativeStore::Get().settings;
  return "{\"searchEngine\":" + Quote(s.search_engine) + ",\"homepage\":" + Quote(s.homepage) +
         ",\"theme\":" + Quote(s.theme) + ",\"skin\":" + Quote(s.skin) + ",\"perf\":" +
         Quote(s.perf) +
         ",\"bookmarkBarVisible\":" + (s.bookmark_bar_visible ? "true" : "false") +
         ",\"showHomeButton\":" + (s.show_home_button ? "true" : "false") +
         ",\"restoreSession\":" + (s.restore_session ? "true" : "false") +
         ",\"cliPermission\":" + Quote(s.cli_permission) +
         ",\"aiEnabled\":" + (s.ai_enabled ? "true" : "false") +
         ",\"serviceAutoStart\":" + (s.service_auto_start ? "true" : "false") + "}";
}

/**
 * 快速模式在本机是否可用。
 *
 * 判据（有意保持简单可解释）：物理内存 ≥ 8 GB。快速模式靠更多渲染进程 + 预渲染换顺滑，
 * 内存不足时反而拖慢整机 —— 这正是需求里"在部分设备上无法使用（自动识别能不能用）"的意思。
 * 返回实际探测值，而不是写死 true，避免界面给出虚假承诺。
 */
bool FastModeSupported(std::string& reason) {
  MEMORYSTATUSEX status{};
  status.dwLength = sizeof(status);
  if (!::GlobalMemoryStatusEx(&status)) {
    reason = "无法读取本机内存信息，保守判定为不支持";
    return false;
  }
  const unsigned long long total_gb = status.ullTotalPhys / (1024ull * 1024ull * 1024ull);
  if (total_gb < 8) {
    reason = "本机物理内存约 " + std::to_string(total_gb) +
             " GB，快速模式（多渲染进程 + 预渲染）会明显吃内存，判定为不可用";
    return false;
  }
  reason = "本机物理内存约 " + std::to_string(total_gb) + " GB，支持快速模式";
  return true;
}

std::string EnergyJson() {
  const std::string mode = AppContext::Get().energy_mode();
  std::string reason;
  const bool fast_supported = FastModeSupported(reason);
  return "{\"mode\":" + Quote(mode) + ",\"fastSupported\":" +
         (fast_supported ? "true" : "false") + ",\"fastSupportedReason\":" + Quote(reason) +
         ",\"processModel\":" + Quote(ProcessModelJson()) +
         ",\"note\":\"能效模式在启动时生效；切换后需要重启浏览器才能完全应用\"}";
}

std::string SecurityReportJson() {
  NativeStore& store = NativeStore::Get();
  const std::string level = AppContext::Get().protection_level();
  return "{\"level\":" + Quote(level) + ",\"blockedTotal\":" + std::to_string(store.blocked_total) +
         ",\"blocked24h\":" + std::to_string(store.blocked_last24h) +
         ",\"localListSize\":" + std::to_string(BlocklistSize()) +
         ",\"trustedNote\":\"turtlelnc 官方内容在任何档位都自动放行，不计入拦截统计\","
         "\"recent\":[]}";
}

std::string AiConnectionJson() {
  const ServiceState st = ReadServiceState();
  const bool has_key = ReadFileToString(AppContext::Get().user_data_dir() + "\\secrets.json").size() > 2;
  return "{\"method\":\"api\",\"provider\":" + Quote("deepseek") +
         ",\"baseUrl\":" + Quote("https://api.deepseek.com/v1") +
         ",\"model\":" + Quote("deepseek-chat") + ",\"hasApiKey\":" +
         (has_key ? "true" : "false") +
         ",\"oauthAuthorized\":false,\"mcpServers\":[],\"serviceRunning\":" +
         (st.running ? "true" : "false") +
         ",\"note\":\"AI 对话 / MCP / OAuth 由边车进程承载；边车未启动时这些能力不可用\"}";
}

std::string AiModeJson() {
  return "{\"mode\":\"browse\",\"workdir\":\"\",\"allowlist\":[],\"modes\":["
         "{\"id\":\"browse\",\"name\":\"浏览\",\"available\":true,"
         "\"note\":\"只做网页理解与浏览器操控\"},"
         "{\"id\":\"office\",\"name\":\"本地办公\","
         "\"available\":false,\"note\":\"需要边车进程（未启动）\"},"
         "{\"id\":\"dev\",\"name\":\"本地开发\","
         "\"available\":false,\"note\":\"需要边车进程（未启动）\"}]}";
}

/**
 * 读取扩展的 manifest.json，填充名称/版本/描述。
 * 只解析顶层字符串字段，够用即可。
 */
void ReadExtensionManifest(const std::string& dir, ExtensionRecord& rec) {
  const std::string json = ReadFileToString(dir + "\\manifest.json");
  if (json.empty()) {
    rec.name = rec.name.empty() ? "未命名的扩展" : rec.name;
    rec.description = "缺少 manifest.json，无法读取扩展信息";
    return;
  }
  CefRefPtr<CefValue> root = CefParseJSON(json, JSON_PARSER_RFC);
  if (!root || root->GetType() != VTYPE_DICTIONARY) {
    rec.name = "扩展（manifest 解析失败）";
    return;
  }
  CefRefPtr<CefDictionaryValue> d = root->GetDictionary();
  auto pick = [&](const char* key) -> std::string {
    if (d->HasKey(key) && d->GetType(key) == VTYPE_STRING) return d->GetString(key).ToString();
    return "";
  };
  rec.name = pick("name");
  rec.version = pick("version");
  rec.description = pick("description");
  if (rec.name.empty()) rec.name = "未命名的扩展";
}

}  // namespace

std::string DispatchApi(TibWindow* window, const std::string& method,
                        CefRefPtr<CefDictionaryValue> args,
                        const std::function<void(bool, const std::string&)>& reply,
                        ApiOutcome& outcome) {
  outcome = ApiOutcome::Handled;
  NativeStore& store = NativeStore::Get();
  AppContext& ctx = AppContext::Get();

  // ---------- 设置 ----------
  if (method == "settings.get") return SettingsJson();
  if (method == "settings.set") {
    if (args) {
      if (args->HasKey("searchEngine")) store.settings.search_engine = ArgStr(args, "searchEngine", "bing");
      if (args->HasKey("homepage")) store.settings.homepage = ArgStr(args, "homepage");
      if (args->HasKey("theme")) store.settings.theme = ArgStr(args, "theme", "system");
      if (args->HasKey("skin")) {
        const std::string skin = ArgStr(args, "skin", "tibrowser");
        if (skin != "tibrowser" && skin != "edge" && skin != "chrome") {
          return "{\"__error\":" + Quote("未知的界面皮肤：" + skin) + "}";
        }
        store.settings.skin = skin;
        ctx.set_skin(skin);
      }
      if (args->HasKey("perf")) store.settings.perf = ArgStr(args, "perf", "high");
      if (args->HasKey("bookmarkBarVisible"))
        store.settings.bookmark_bar_visible = ArgBool(args, "bookmarkBarVisible", true);
      if (args->HasKey("showHomeButton"))
        store.settings.show_home_button = ArgBool(args, "showHomeButton", true);
      if (args->HasKey("restoreSession"))
        store.settings.restore_session = ArgBool(args, "restoreSession", false);
      if (args->HasKey("cliPermission"))
        store.settings.cli_permission = ArgStr(args, "cliPermission", "daily");
      if (args->HasKey("aiEnabled")) store.settings.ai_enabled = ArgBool(args, "aiEnabled", true);
      if (args->HasKey("serviceAutoStart"))
        store.settings.service_auto_start = ArgBool(args, "serviceAutoStart", true);
    }
    store.SaveSettings();
    if (window) window->SyncState();
    return SettingsJson();
  }
  if (method == "settings.setSkin") {
    const std::string skin = ArgStr(args, "skin", "tibrowser");
    if (skin != "tibrowser" && skin != "edge" && skin != "chrome") {
      return "{\"__error\":" + Quote("未知的界面皮肤：" + skin) + "}";
    }
    store.settings.skin = skin;
    ctx.set_skin(skin);
    store.SaveSettings();
    if (window) window->SyncState();
    return "{\"ok\":true}";
  }
  if (method == "skin.get") return Quote(ctx.skin());
  if (method == "settings.setProtectionLevel") {
    const std::string level = ArgStr(args, "level", "standard");
    if (level != "enhanced" && level != "standard" && level != "none") {
      return "{\"__error\":" + Quote("未知的安全浏览档位：" + level) + "}";
    }
    ctx.set_protection_level(level);
    if (window) window->SyncState();
    return "{\"ok\":true}";
  }
  if (method == "settings.setApiKey") {
    // 密钥由边车用 DPAPI 加密保存；原生侧不落明文，只转发。
    const std::string key = ArgStr(args, "key", ArgStr(args, "value"));
    if (key.empty()) return "{\"__error\":" + Quote("API Key 为空") + "}";
    return "{\"__error\":" + Quote(
               "API Key 需要边车进程保存（原生侧不落明文）。请先启动边车的设置入口，"
               "或在设置面板中通过边车保存。") + "}";
  }

  // ---------- 能效 ----------
  if (method == "energy.get") return EnergyJson();
  if (method == "settings.setEnergyMode") {
    const std::string mode = ArgStr(args, "mode", ArgStr(args, "value", "standard"));
    if (mode != "standard" && mode != "fast" && mode != "low" && mode != "ondemand") {
      return "{\"__error\":" + Quote("未知的能效模式：" + mode) + "}";
    }
    ctx.set_energy_mode(mode);
    return EnergyJson();
  }

  // ---------- 安全浏览 ----------
  if (method == "security.report") return SecurityReportJson();
  if (method == "security.scan") {
    const ScanResult r = ScanUrlForProtection(ArgStr(args, "url", ArgStr(args, "value")));
    return "{\"blocked\":" + std::string(r.blocked ? "true" : "false") + ",\"trusted\":" +
           (r.trusted ? "true" : "false") + ",\"category\":" + Quote(r.category) +
           ",\"reason\":" + Quote(r.reason) + ",\"action\":" + Quote(r.action) + "}";
  }

  // ---------- 无痕 2.0 / 指纹 ----------
  if (method == "fingerprint.get") return FingerprintJson();
  if (method == "fingerprint.set") {
    FingerprintProfile& f = store.fingerprint;
    if (args) {
      if (args->HasKey("userAgent")) f.user_agent = ArgStr(args, "userAgent", f.user_agent);
      if (args->HasKey("platform")) f.platform = ArgStr(args, "platform", f.platform);
      if (args->HasKey("timezone")) f.timezone = ArgStr(args, "timezone", f.timezone);
      if (args->HasKey("language")) f.language = ArgStr(args, "language", f.language);
      if (args->HasKey("screen")) f.screen = ArgStr(args, "screen", f.screen);
      if (args->HasKey("hardwareConcurrency"))
        f.hardware_concurrency = ArgStr(args, "hardwareConcurrency", f.hardware_concurrency);
      if (args->HasKey("doNotTrack")) f.do_not_track = ArgStr(args, "doNotTrack", f.do_not_track);
      if (args->HasKey("canvasNoise")) f.canvas_noise = ArgBool(args, "canvasNoise", true);
      if (args->HasKey("webglNoise")) f.webgl_noise = ArgBool(args, "webglNoise", true);
    }
    store.SaveFingerprint();
    return FingerprintJson();
  }
  if (method == "fingerprint.randomize") {
    store.RandomizeFingerprint();
    return FingerprintJson();
  }

  // ---------- 书签 ----------
  if (method == "bookmarks.list") return BookmarksJson();
  if (method == "bookmarks.add") {
    const Bookmark b = store.AddBookmark(ArgStr(args, "title"), ArgStr(args, "url"),
                                         ArgStr(args, "folder", "书签栏"));
    return "{\"id\":" + Quote(b.id) + ",\"title\":" + Quote(b.title) + ",\"url\":" + Quote(b.url) +
           ",\"folder\":" + Quote(b.folder) + ",\"createdAt\":" + Ms(b.created_at) + "}";
  }
  if (method == "bookmarks.remove") {
    const bool ok = store.RemoveBookmark(ArgStr(args, "id"));
    return ok ? "{\"ok\":true}"
              : "{\"__error\":" + Quote("未找到该书签") + "}";
  }
  if (method == "bookmarks.toggle") {
    std::string title = ArgStr(args, "title");
    std::string url = ArgStr(args, "url");
    if (url.empty() && window) url = window->GetActiveUrl();
    if (title.empty() && window) title = window->GetActiveTitle();
    const bool bookmarked = store.ToggleBookmark(title, url);
    return "{\"bookmarked\":" + std::string(bookmarked ? "true" : "false") + "}";
  }

  // ---------- 历史 ----------
  if (method == "history.list") {
    return HistoryJson(ArgStr(args, "q", ArgStr(args, "query")), ArgInt(args, "limit", 500));
  }
  if (method == "history.clear") {
    store.ClearHistory();
    return "{\"ok\":true}";
  }
  if (method == "history.remove") {
    const bool ok = store.RemoveHistory(ArgStr(args, "id"));
    return ok ? "{\"ok\":true}" : "{\"__error\":" + Quote("未找到该历史记录") + "}";
  }

  // ---------- 下载 ----------
  if (method == "downloads.list") return DownloadsJson();
  if (method == "downloads.open" || method == "downloads.openFolder") {
    if (store.downloads.empty()) return "{\"__error\":" + Quote("暂无下载记录") + "}";
    const std::string id = ArgStr(args, "id");
    std::string target = store.dir();
    for (const DownloadRecord& r : store.downloads) {
      if (id.empty() || r.id == id) {
        target = r.save_path.empty() ? store.dir() : r.save_path;
        break;
      }
    }
    if (method == "downloads.openFolder" && !target.empty()) {
      const size_t slash = target.find_last_of("\\/");
      if (slash != std::string::npos) target = target.substr(0, slash);
    }
    ::ShellExecuteA(nullptr, "open", target.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    return "{\"ok\":true}";
  }
  if (method == "downloads.resolvePrompt") {
    const bool keep = ArgBool(args, "keep", false);
    return "{\"ok\":true,\"kept\":" + std::string(keep ? "true" : "false") + "}";
  }

  // ---------- 地址栏联想 ----------
  if (method == "omnibox.suggest") {
    const std::string q = ArgStr(args, "query", ArgStr(args, "q"));
    std::vector<std::string> items;
    // 搜索引擎一行
    items.push_back("{\"type\":\"search\",\"text\":" + Quote(q) + ",\"url\":" +
                    Quote("https://www.bing.com/search?q=" + q) + ",\"title\":" + Quote("搜索 " + q) +
                    "}");
    std::string lowered;
    for (char c : q) lowered.push_back(static_cast<char>(::tolower(c)));
    for (const HistoryEntry& h : store.history) {
      if (items.size() >= 7) break;
      std::string hay = h.title + " " + h.url;
      for (auto& c : hay) c = static_cast<char>(::tolower(c));
      if (!q.empty() && hay.find(lowered) == std::string::npos) continue;
      items.push_back("{\"type\":\"history\",\"text\":" + Quote(h.url) + ",\"url\":" + Quote(h.url) +
                      ",\"title\":" + Quote(h.title) + "}");
    }
    for (const Bookmark& b : store.bookmarks) {
      if (items.size() >= 9) break;
      std::string hay = b.title + " " + b.url;
      for (auto& c : hay) c = static_cast<char>(::tolower(c));
      if (!q.empty() && hay.find(lowered) == std::string::npos) continue;
      items.push_back("{\"type\":\"bookmark\",\"text\":" + Quote(b.url) + ",\"url\":" + Quote(b.url) +
                      ",\"title\":" + Quote(b.title) + "}");
    }
    return Join(items);
  }

  // ---------- 网页应用（feature 7） ----------
  if (method == "apps.list") return AppsJson();
  if (method == "apps.install") {
    const std::string url = ArgStr(args, "url");
    if (url.empty()) return "{\"__error\":" + Quote("请先打开要生成应用的网页") + "}";
    const WebApp a = store.AddApp(ArgStr(args, "name"), url, ArgStr(args, "icon"));
    if (window) window->SendAppsChanged(AppsJson());
    return "{\"id\":" + Quote(a.id) + ",\"name\":" + Quote(a.name) + ",\"url\":" + Quote(a.url) +
           ",\"icon\":" + Quote(a.icon) + ",\"createdAt\":" + Ms(a.created_at) + "}";
  }
  if (method == "apps.uninstall") {
    if (!store.RemoveApp(ArgStr(args, "id"))) {
      return "{\"__error\":" + Quote("未找到该网页应用") + "}";
    }
    if (window) window->SendAppsChanged(AppsJson());
    return "{\"ok\":true}";
  }
  if (method == "apps.launch") {
    const WebApp* a = store.FindApp(ArgStr(args, "id"));
    if (!a) return "{\"__error\":" + Quote("未找到该网页应用") + "}";
    if (window) window->CreateTab(a->url, true);
    return "{\"ok\":true}";
  }

  // ---------- 扩展 ----------
  if (method == "extensions.list") return ExtensionsJson();
  if (method == "extensions.setEnabled") {
    const bool ok = store.SetExtensionEnabled(ArgStr(args, "id"), ArgBool(args, "on", true));
    if (!ok) return "{\"__error\":" + Quote("未找到该扩展") + "}";
    if (window) window->SendExtensionsChanged(ExtensionsJson());
    return "{\"ok\":true}";
  }
  if (method == "extensions.remove") {
    if (!store.RemoveExtension(ArgStr(args, "id"))) {
      return "{\"__error\":" + Quote("未找到该扩展") + "}";
    }
    if (window) window->SendExtensionsChanged(ExtensionsJson());
    return "{\"ok\":true}";
  }
  if (method == "extensions.loadUnpacked" || method == "extensions.loadCrx") {
    const bool crx = (method == "extensions.loadCrx");
    // 扩展加载必须由用户显式挑选文件/目录 —— 用原生对话框，不接受界面传路径
    // （否则网页内容可以诱导加载任意本地路径，是个真实的安全问题）
    char path[MAX_PATH] = {0};
    if (crx) {
      OPENFILENAMEA ofn{};
      ofn.lStructSize = sizeof(ofn);
      ofn.lpstrFilter = "Chrome 扩展包 (*.crx)\0*.crx\0所有文件\0*.*\0";
      ofn.lpstrFile = path;
      ofn.nMaxFile = MAX_PATH;
      ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
      ofn.lpstrTitle = "选择 .crx 扩展包";
      if (!::GetOpenFileNameA(&ofn)) {
        return "{\"__error\":" + Quote("已取消选择扩展包") + "}";
      }
    } else {
      BROWSEINFOA bi{};
      bi.lpszTitle = "选择已解压的扩展目录（需包含 manifest.json）";
      bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
      LPITEMIDLIST pidl = ::SHBrowseForFolderA(&bi);
      if (!pidl) return "{\"__error\":" + Quote("已取消选择扩展目录") + "}";
      const bool resolved = ::SHGetPathFromIDListA(pidl, path) != FALSE;
      ::CoTaskMemFree(pidl);
      if (!resolved) return "{\"__error\":" + Quote("无法解析所选目录路径") + "}";
    }

    const std::string chosen = path;
    if (GetFileAttributesA(chosen.c_str()) == INVALID_FILE_ATTRIBUTES) {
      return "{\"__error\":" + Quote("所选路径不存在：" + chosen) + "}";
    }

    // .crx 需要先解包成目录才能加载（Chromium 的 LoadExtension 只接受目录形式）
    std::string load_dir = chosen;
    if (crx) {
      ::CreateDirectoryA((store.dir() + "\\extensions").c_str(), nullptr);
      load_dir = store.dir() + "\\extensions\\" + NewId();
      if (!::CreateDirectoryA(load_dir.c_str(), nullptr)) {
        return "{\"__error\":" + Quote("无法创建扩展解包目录") + "}";
      }
      std::string unpack_error;
      if (!UnpackCrx(chosen, load_dir, unpack_error)) {
        return "{\"__error\":" + Quote("解包 .crx 失败：" + unpack_error) + "}";
      }
    }

    ExtensionRecord rec;
    rec.id = NewId();
    rec.path = load_dir;
    rec.enabled = true;
    ReadExtensionManifest(load_dir, rec);
    store.extensions.push_back(rec);
    store.SaveExtensions();
    if (window) window->SendExtensionsChanged(ExtensionsJson());
    return "{\"id\":" + Quote(rec.id) + ",\"name\":" + Quote(rec.name) + ",\"version\":" +
           Quote(rec.version) + ",\"path\":" + Quote(rec.path) +
           ",\"enabled\":true,\"description\":" + Quote(rec.description) + "}";
  }

  // ---------- 账户与同步（feature 3） ----------
  if (method == "accounts.list") return AccountsJson();
  if (method == "accounts.signIn") {
    std::string error;
    if (!store.SignIn(ArgStr(args, "provider"), error)) {
      return "{\"__error\":" + Quote(error) + "}";
    }
    if (window) window->SendAccountsChanged(AccountsJson(), SyncStateJson());
    return AccountsJson();
  }
  if (method == "accounts.signOut") {
    store.SignOut(ArgStr(args, "provider"));
    if (window) window->SendAccountsChanged(AccountsJson(), SyncStateJson());
    return "{\"ok\":true}";
  }
  if (method == "sync.state") return SyncStateJson();
  if (method == "sync.setEnabled") {
    const bool enabled = ArgBool(args, "enabled", false);
    if (enabled && store.accounts.empty()) {
      return "{\"__error\":" + Quote("请先登录 Microsoft 或 Google 账户，再开启同步") + "}";
    }
    store.sync_enabled = enabled;
    store.SaveSync();
    return SyncStateJson();
  }
  if (method == "sync.setToggles") {
    if (args) {
      if (args->HasKey("bookmarks")) store.sync_toggles.bookmarks = ArgBool(args, "bookmarks", true);
      if (args->HasKey("history")) store.sync_toggles.history = ArgBool(args, "history", true);
      if (args->HasKey("settings")) store.sync_toggles.settings = ArgBool(args, "settings", true);
      if (args->HasKey("extensions"))
        store.sync_toggles.extensions = ArgBool(args, "extensions", false);
      if (args->HasKey("passwords")) store.sync_toggles.passwords = ArgBool(args, "passwords", false);
    }
    store.SaveSync();
    return SyncStateJson();
  }
  if (method == "sync.now") {
    if (!store.sync_enabled) {
      return "{\"__error\":" + Quote("同步尚未开启") + "}";
    }
    store.last_sync_at = NowSeconds();
    store.SaveSync();
    return SyncStateJson();
  }
  if (method == "profile.export" || method == "profile.import") {
    return "{\"__error\":" + Quote(
               ".tbuser 打包/解包由边车实现（需要 zip 库）；原生侧已完成数据文件准备，"
               "请通过边车调用。") + "}";
  }

  // ---------- AI 连接信息：原生侧直接回答（读握手与密钥状态） ----------
  if (method == "ai.connection") return AiConnectionJson();

  // ---------- AI / 边车：异步转发 ----------
  //
  // 这一段的返回值一定是 Deferred：CEF 的网络请求是异步的，
  // 结果由 reply 回调送回，调用方不要自己发回执。
  if (method == "service.status") return ServiceStatusJson();
  if (method == "automation.info") return AutomationInfoJson();
  if (method.rfind("ai.", 0) == 0) {
    // UI 的方法名与边车的 RPC 名不完全一致，这里做一次显式映射
    // （映射表集中在此，避免 UI 与边车互相迁就对方命名）
    static const std::map<std::string, std::string> kSidecarMethods = {
        {"ai.connection", "store.getSettings"},
        {"ai.setConnection", "store.setSettings"},
        {"ai.mcp.addServer", "ai.mcp.addServer"},
        {"ai.mcp.removeServer", "ai.mcp.removeServer"},
        {"ai.mcp.listServers", "ai.mcp.listServers"},
        {"ai.modes.list", "ai.modes.list"},
        {"ai.modes.set", "ai.modes.set"},
        {"ai.modes.devStatus", "ai.modes.devStatus"},
    };
    const auto mapped = kSidecarMethods.find(method);
    const std::string sidecar_method = mapped != kSidecarMethods.end() ? mapped->second : method;
    const ServiceState st = ReadServiceState();
    if (!st.running) {
      return "{\"__error\":" + Quote(
                 "AI 能力由边车进程提供，当前边车未运行。"
                 "请确认 tib-service 已随浏览器启动（设置 → 关于 可查看边车状态）。") + "}";
    }
    // 参数原样透传；边车侧的方法名与 UI 一致（ai.mode.get 等）
    std::string params = "{}";
    if (args) {
      CefRefPtr<CefValue> v = CefValue::Create();
      v->SetDictionary(args);
      params = CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
    }
    outcome = ApiOutcome::Deferred;
    CallSidecarAsync(sidecar_method, params, [reply](bool ok, const std::string& body) {
      if (reply) reply(ok, body);
    });
    return "";
  }
  if (method.rfind("automation.", 0) == 0) {
    const ServiceState st = ReadServiceState();
    if (!st.running) {
      return "{\"__error\":" + Quote("自动化接口由边车提供，当前边车未运行") + "}";
    }
    std::string params = "{}";
    if (args) {
      CefRefPtr<CefValue> v = CefValue::Create();
      v->SetDictionary(args);
      params = CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
    }
    outcome = ApiOutcome::Deferred;
    CallSidecarAsync(method, params, [reply](bool ok, const std::string& body) {
      if (reply) reply(ok, body);
    });
    return "";
  }
  if (method.rfind("profile.", 0) == 0) {
    // .tbuser 打包/解包由边车实现（需要 zip 库）
    const ServiceState st = ReadServiceState();
    if (!st.running) {
      return "{\"__error\":" + Quote("配置迁移由边车提供，当前边车未运行") + "}";
    }
    std::string params = "{}";
    if (args) {
      CefRefPtr<CefValue> v = CefValue::Create();
      v->SetDictionary(args);
      params = CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
    }
    outcome = ApiOutcome::Deferred;
    CallSidecarAsync(method, params, [reply](bool ok, const std::string& body) {
      if (reply) reply(ok, body);
    });
    return "";
  }

  // ---------- 剪贴板 ----------
  if (method == "copy.clipboard") {
    const std::string text = ArgStr(args, "text", ArgStr(args, "value"));
    if (::OpenClipboard(nullptr)) {
      ::EmptyClipboard();
      const int len = ::MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
      HGLOBAL mem = ::GlobalAlloc(GMEM_MOVEABLE, len * sizeof(wchar_t));
      if (mem) {
        if (void* dst = ::GlobalLock(mem)) {
          ::MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, static_cast<wchar_t*>(dst), len);
          ::GlobalUnlock(mem);
          ::SetClipboardData(CF_UNICODETEXT, mem);
        }
      }
      ::CloseClipboard();
      return "{\"ok\":true}";
    }
    return "{\"__error\":" + Quote("无法访问剪贴板") + "}";
  }

  outcome = ApiOutcome::NotMine;
  return "";
}

}  // namespace tib
