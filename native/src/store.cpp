// 原生轻量存储实现。
// 序列化用 CEF 自带的 JSON 写入器，反序列化用 CefParseJSON —— 不引入额外依赖，
// 且与浏览器内核使用同一套 JSON 实现，避免转义/编码上的分歧。
#include "store.h"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <fstream>
#include <random>

namespace tib {
namespace {

/** 把字符串安全地放进 JSON：借助 CEF 的写入器，避免手写转义出错 */
std::string Quote(const std::string& in) {
  CefRefPtr<CefValue> v = CefValue::Create();
  v->SetString(in);
  return CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
}

/** 取字符串字段，缺失返回 fallback */
std::string Str(CefRefPtr<CefDictionaryValue> d, const char* key,
                const std::string& fallback = "") {
  if (!d || !d->HasKey(key)) return fallback;
  if (d->GetType(key) == VTYPE_STRING) return d->GetString(key).ToString();
  return fallback;
}

int64_t Int(CefRefPtr<CefDictionaryValue> d, const char* key, int64_t fallback = 0) {
  if (!d || !d->HasKey(key)) return fallback;
  if (d->GetType(key) == VTYPE_INT) return d->GetInt(key);
  if (d->GetType(key) == VTYPE_DOUBLE) return static_cast<int64_t>(d->GetDouble(key));
  return fallback;
}

bool Bool(CefRefPtr<CefDictionaryValue> d, const char* key, bool fallback = false) {
  if (!d || !d->HasKey(key)) return fallback;
  if (d->GetType(key) == VTYPE_BOOL) return d->GetBool(key);
  return fallback;
}

/** 解析顶层数组；失败返回空列表 */
std::vector<CefRefPtr<CefDictionaryValue>> ParseArray(const std::string& json) {
  std::vector<CefRefPtr<CefDictionaryValue>> out;
  if (json.empty()) return out;
  CefRefPtr<CefValue> root = CefParseJSON(json, JSON_PARSER_RFC);
  if (!root || root->GetType() != VTYPE_LIST) return out;
  CefRefPtr<CefListValue> list = root->GetList();
  for (size_t i = 0; i < list->GetSize(); ++i) {
    if (list->GetType(i) != VTYPE_DICTIONARY) continue;
    out.push_back(list->GetDictionary(i));
  }
  return out;
}

/** 解析顶层对象；失败返回 nullptr */
CefRefPtr<CefDictionaryValue> ParseObject(const std::string& json) {
  if (json.empty()) return nullptr;
  CefRefPtr<CefValue> root = CefParseJSON(json, JSON_PARSER_RFC);
  if (!root || root->GetType() != VTYPE_DICTIONARY) return nullptr;
  return root->GetDictionary();
}

std::string ListToJson(const std::vector<std::string>& items) {
  std::string out = "[";
  for (size_t i = 0; i < items.size(); ++i) {
    if (i) out += ",";
    out += items[i];
  }
  out += "]";
  return out;
}

}  // namespace

std::string NewId() {
  static std::mt19937_64 rng(
      static_cast<uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count()));
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(16);
  for (int i = 0; i < 16; ++i) out.push_back(hex[rng() & 0xF]);
  return out;
}

int64_t NowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string JsonEscapePublic(const std::string& in) {
  std::string v = Quote(in);
  // 去掉首尾引号，得到「可直接放进 JSON 字符串内部」的转义形式
  if (v.size() >= 2 && v.front() == '"' && v.back() == '"') return v.substr(1, v.size() - 2);
  return v;
}

NativeStore& NativeStore::Get() {
  static NativeStore instance;
  return instance;
}

void NativeStore::WriteJson(const std::string& file, const std::string& json) const {
  if (dir_.empty()) return;
  const std::string path = dir_ + "\\" + file;
  const std::string tmp = path + ".tmp";
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    if (!out) return;
    out.write(json.data(), static_cast<std::streamsize>(json.size()));
    out.flush();
  }
  // 原子替换：Windows 上 rename 不能覆盖已存在文件，先删再改名
  ::DeleteFileA(path.c_str());
  if (!::MoveFileA(tmp.c_str(), path.c_str())) {
    ::DeleteFileA(tmp.c_str());
  }
}

std::string NativeStore::ReadJson(const std::string& file) const {
  if (dir_.empty()) return "";
  return ReadFileToString(dir_ + "\\" + file);
}

void NativeStore::Init() {
  if (ready_) return;
  dir_ = AppContext::Get().user_data_dir();
  ready_ = true;

  // ---- 设置 ----
  if (CefRefPtr<CefDictionaryValue> d = ParseObject(ReadJson("settings.json"))) {
    settings.search_engine = Str(d, "searchEngine", settings.search_engine);
    settings.homepage = Str(d, "homepage", settings.homepage);
    settings.theme = Str(d, "theme", settings.theme);
    settings.skin = Str(d, "skin", settings.skin);
    settings.perf = Str(d, "perf", settings.perf);
    settings.bookmark_bar_visible = Bool(d, "bookmarkBarVisible", true);
    settings.show_home_button = Bool(d, "showHomeButton", true);
    settings.restore_session = Bool(d, "restoreSession", false);
    settings.cli_permission = Str(d, "cliPermission", settings.cli_permission);
    settings.ai_enabled = Bool(d, "aiEnabled", true);
    settings.service_auto_start = Bool(d, "serviceAutoStart", true);
  }

  // ---- 书签 ----
  for (const auto& d : ParseArray(ReadJson("bookmarks.json"))) {
    Bookmark b;
    b.id = Str(d, "id");
    b.title = Str(d, "title");
    b.url = Str(d, "url");
    b.folder = Str(d, "folder", "书签栏");
    b.created_at = Int(d, "createdAt");
    if (!b.id.empty()) bookmarks.push_back(b);
  }

  // ---- 历史 ----
  for (const auto& d : ParseArray(ReadJson("history.json"))) {
    HistoryEntry h;
    h.id = Str(d, "id");
    h.title = Str(d, "title");
    h.url = Str(d, "url");
    h.visited_at = Int(d, "visitedAt");
    if (!h.id.empty()) history.push_back(h);
  }

  // ---- 下载 ----
  for (const auto& d : ParseArray(ReadJson("downloads.json"))) {
    DownloadRecord r;
    r.id = Str(d, "id");
    r.filename = Str(d, "filename");
    r.url = Str(d, "url");
    r.save_path = Str(d, "savePath");
    r.received = Int(d, "receivedBytes");
    r.total = Int(d, "totalBytes");
    r.state = Str(d, "state", "completed");
    r.suspicious = Bool(d, "suspicious", false);
    r.suspicious_reason = Str(d, "suspiciousReason");
    r.started_at = Int(d, "startedAt");
    if (!r.id.empty()) downloads.push_back(r);
  }

  // ---- 网页应用 ----
  for (const auto& d : ParseArray(ReadJson("webapps.json"))) {
    WebApp a;
    a.id = Str(d, "id");
    a.name = Str(d, "name");
    a.url = Str(d, "url");
    a.icon = Str(d, "icon");
    a.created_at = Int(d, "createdAt");
    if (!a.id.empty()) apps.push_back(a);
  }

  // ---- 扩展 ----
  for (const auto& d : ParseArray(ReadJson("extensions.json"))) {
    ExtensionRecord e;
    e.id = Str(d, "id");
    e.name = Str(d, "name");
    e.version = Str(d, "version");
    e.path = Str(d, "path");
    e.enabled = Bool(d, "enabled", true);
    e.description = Str(d, "description");
    if (!e.id.empty()) extensions.push_back(e);
  }

  // ---- 指纹画像 ----
  if (CefRefPtr<CefDictionaryValue> d = ParseObject(ReadJson("fingerprint.json"))) {
    FingerprintProfile f;
    f.user_agent = Str(d, "userAgent", f.user_agent);
    f.platform = Str(d, "platform", f.platform);
    f.timezone = Str(d, "timezone", f.timezone);
    f.language = Str(d, "language", f.language);
    f.screen = Str(d, "screen", f.screen);
    f.hardware_concurrency = Str(d, "hardwareConcurrency", f.hardware_concurrency);
    f.do_not_track = Str(d, "doNotTrack", f.do_not_track);
    f.canvas_noise = Bool(d, "canvasNoise", true);
    f.webgl_noise = Bool(d, "webglNoise", true);
    fingerprint = f;
  }

  // ---- 账户与同步 ----
  for (const auto& d : ParseArray(ReadJson("accounts.json"))) {
    AccountRecord a;
    a.provider = Str(d, "provider");
    a.email = Str(d, "email");
    a.display_name = Str(d, "displayName");
    a.signed_in_at = Int(d, "signedInAt");
    if (!a.provider.empty()) accounts.push_back(a);
  }
  if (CefRefPtr<CefDictionaryValue> d = ParseObject(ReadJson("sync.json"))) {
    sync_enabled = Bool(d, "enabled", false);
    last_sync_at = Int(d, "lastSyncAt");
    if (d->HasKey("toggles") && d->GetType("toggles") == VTYPE_DICTIONARY) {
      CefRefPtr<CefDictionaryValue> t = d->GetDictionary("toggles");
      sync_toggles.bookmarks = Bool(t, "bookmarks", true);
      sync_toggles.history = Bool(t, "history", true);
      sync_toggles.settings = Bool(t, "settings", true);
      sync_toggles.extensions = Bool(t, "extensions", false);
      sync_toggles.passwords = Bool(t, "passwords", false);
    }
  }

  Log("原生存储就绪：书签 " + std::to_string(bookmarks.size()) + " 条、历史 " +
      std::to_string(history.size()) + " 条、下载 " + std::to_string(downloads.size()) +
      " 条、网页应用 " + std::to_string(apps.size()) + " 个、扩展 " +
      std::to_string(extensions.size()) + " 个、账户 " + std::to_string(accounts.size()) + " 个");
}

void NativeStore::SaveSettings() {
  std::vector<std::string> items = {
      "\"searchEngine\":" + Quote(settings.search_engine),
      "\"homepage\":" + Quote(settings.homepage),
      "\"theme\":" + Quote(settings.theme),
      "\"skin\":" + Quote(settings.skin),
      "\"perf\":" + Quote(settings.perf),
      "\"bookmarkBarVisible\":" + std::string(settings.bookmark_bar_visible ? "true" : "false"),
      "\"showHomeButton\":" + std::string(settings.show_home_button ? "true" : "false"),
      "\"restoreSession\":" + std::string(settings.restore_session ? "true" : "false"),
      "\"cliPermission\":" + Quote(settings.cli_permission),
      "\"aiEnabled\":" + std::string(settings.ai_enabled ? "true" : "false"),
      "\"serviceAutoStart\":" + std::string(settings.service_auto_start ? "true" : "false"),
  };
  WriteJson("settings.json", "{" + [&] {
              std::string s;
              for (size_t i = 0; i < items.size(); ++i) {
                if (i) s += ",";
                s += items[i];
              }
              return s;
            }() + "}");
  NotifySettingsChanged();
}

void NativeStore::NotifySettingsChanged() const {
  // 边车负责 AI/皮肤等运行期状态；这里只写一个变更标记文件，
  // 由边车轮询或下次 RPC 时读取（避免在原生侧实现完整的 HTTP 客户端调用）。
  const std::string marker = dir_ + "\\settings.changed";
  std::ofstream out(marker, std::ios::binary | std::ios::trunc);
  if (out) out << NowSeconds();
}

void NativeStore::SaveBookmarks() {
  std::vector<std::string> items;
  for (const Bookmark& b : bookmarks) {
    items.push_back("{\"id\":" + Quote(b.id) + ",\"title\":" + Quote(b.title) + ",\"url\":" +
                    Quote(b.url) + ",\"folder\":" + Quote(b.folder) +
                    ",\"createdAt\":" + std::to_string(b.created_at) + "}");
  }
  WriteJson("bookmarks.json", ListToJson(items));
}

Bookmark NativeStore::AddBookmark(const std::string& title, const std::string& url,
                                  const std::string& folder) {
  // 同 URL 视为同一条，避免重复收藏
  for (Bookmark& b : bookmarks) {
    if (b.url == url) {
      if (!title.empty()) b.title = title;
      SaveBookmarks();
      return b;
    }
  }
  Bookmark b;
  b.id = NewId();
  b.title = title.empty() ? url : title;
  b.url = url;
  b.folder = folder;
  b.created_at = NowSeconds();
  bookmarks.insert(bookmarks.begin(), b);
  SaveBookmarks();
  return b;
}

bool NativeStore::RemoveBookmark(const std::string& id) {
  const auto it = std::remove_if(bookmarks.begin(), bookmarks.end(),
                                 [&](const Bookmark& b) { return b.id == id; });
  if (it == bookmarks.end()) return false;
  bookmarks.erase(it, bookmarks.end());
  SaveBookmarks();
  return true;
}

bool NativeStore::ToggleBookmark(const std::string& title, const std::string& url) {
  for (auto it = bookmarks.begin(); it != bookmarks.end(); ++it) {
    if (it->url == url) {
      bookmarks.erase(it);
      SaveBookmarks();
      return false;  // 已取消收藏
    }
  }
  AddBookmark(title, url);
  return true;
}

void NativeStore::SaveHistory() {
  std::vector<std::string> items;
  for (const HistoryEntry& h : history) {
    items.push_back("{\"id\":" + Quote(h.id) + ",\"title\":" + Quote(h.title) + ",\"url\":" +
                    Quote(h.url) + ",\"visitedAt\":" + std::to_string(h.visited_at) + "}");
  }
  WriteJson("history.json", ListToJson(items));
}

void NativeStore::AddHistory(const std::string& title, const std::string& url) {
  if (url.empty() || url.rfind("about:", 0) == 0) return;
  // 与上一条相同则只更新时间，避免刷新灌满历史
  if (!history.empty() && history.front().url == url) {
    history.front().visited_at = NowSeconds();
    if (!title.empty()) history.front().title = title;
    SaveHistory();
    return;
  }
  HistoryEntry h;
  h.id = NewId();
  h.title = title.empty() ? url : title;
  h.url = url;
  h.visited_at = NowSeconds();
  history.insert(history.begin(), h);
  // 上限 2000 条，超出丢弃最旧（与 v0.1.0 行为一致）
  if (history.size() > 2000) history.resize(2000);
  SaveHistory();
}

void NativeStore::ClearHistory() {
  history.clear();
  SaveHistory();
}

bool NativeStore::RemoveHistory(const std::string& id) {
  const auto it = std::remove_if(history.begin(), history.end(),
                                 [&](const HistoryEntry& h) { return h.id == id; });
  if (it == history.end()) return false;
  history.erase(it, history.end());
  SaveHistory();
  return true;
}

void NativeStore::SaveDownloads() {
  std::vector<std::string> items;
  for (const DownloadRecord& r : downloads) {
    items.push_back("{\"id\":" + Quote(r.id) + ",\"filename\":" + Quote(r.filename) +
                    ",\"url\":" + Quote(r.url) + ",\"savePath\":" + Quote(r.save_path) +
                    ",\"receivedBytes\":" + std::to_string(r.received) +
                    ",\"totalBytes\":" + std::to_string(r.total) + ",\"state\":" + Quote(r.state) +
                    ",\"suspicious\":" + (r.suspicious ? "true" : "false") +
                    ",\"suspiciousReason\":" + Quote(r.suspicious_reason) +
                    ",\"startedAt\":" + std::to_string(r.started_at) + "}");
  }
  WriteJson("downloads.json", ListToJson(items));
}

void NativeStore::UpsertDownload(const DownloadRecord& record) {
  for (DownloadRecord& r : downloads) {
    if (r.id == record.id) {
      r = record;
      SaveDownloads();
      return;
    }
  }
  downloads.insert(downloads.begin(), record);
  SaveDownloads();
}

void NativeStore::SaveApps() {
  std::vector<std::string> items;
  for (const WebApp& a : apps) {
    items.push_back("{\"id\":" + Quote(a.id) + ",\"name\":" + Quote(a.name) + ",\"url\":" +
                    Quote(a.url) + ",\"icon\":" + Quote(a.icon) +
                    ",\"createdAt\":" + std::to_string(a.created_at) + "}");
  }
  WriteJson("webapps.json", ListToJson(items));
}

WebApp NativeStore::AddApp(const std::string& name, const std::string& url,
                           const std::string& icon) {
  WebApp a;
  a.id = NewId();
  a.name = name.empty() ? url : name;
  a.url = url;
  a.icon = icon;
  a.created_at = NowSeconds();
  apps.insert(apps.begin(), a);
  SaveApps();
  return a;
}

bool NativeStore::RemoveApp(const std::string& id) {
  const auto it = std::remove_if(apps.begin(), apps.end(),
                                 [&](const WebApp& a) { return a.id == id; });
  if (it == apps.end()) return false;
  apps.erase(it, apps.end());
  SaveApps();
  return true;
}

const WebApp* NativeStore::FindApp(const std::string& id) const {
  for (const WebApp& a : apps) {
    if (a.id == id) return &a;
  }
  return nullptr;
}

void NativeStore::SaveExtensions() {
  std::vector<std::string> items;
  for (const ExtensionRecord& e : extensions) {
    items.push_back("{\"id\":" + Quote(e.id) + ",\"name\":" + Quote(e.name) +
                    ",\"version\":" + Quote(e.version) + ",\"path\":" + Quote(e.path) +
                    ",\"enabled\":" + (e.enabled ? "true" : "false") +
                    ",\"description\":" + Quote(e.description) + "}");
  }
  WriteJson("extensions.json", ListToJson(items));
}

bool NativeStore::RemoveExtension(const std::string& id) {
  const auto it =
      std::remove_if(extensions.begin(), extensions.end(),
                     [&](const ExtensionRecord& e) { return e.id == id; });
  if (it == extensions.end()) return false;
  extensions.erase(it, extensions.end());
  SaveExtensions();
  return true;
}

bool NativeStore::SetExtensionEnabled(const std::string& id, bool enabled) {
  for (ExtensionRecord& e : extensions) {
    if (e.id == id) {
      e.enabled = enabled;
      SaveExtensions();
      return true;
    }
  }
  return false;
}

void NativeStore::SaveFingerprint() {
  const FingerprintProfile& f = fingerprint;
  WriteJson("fingerprint.json",
            "{\"userAgent\":" + Quote(f.user_agent) + ",\"platform\":" + Quote(f.platform) +
                ",\"timezone\":" + Quote(f.timezone) + ",\"language\":" + Quote(f.language) +
                ",\"screen\":" + Quote(f.screen) + ",\"hardwareConcurrency\":" +
                Quote(f.hardware_concurrency) + ",\"doNotTrack\":" + Quote(f.do_not_track) +
                ",\"canvasNoise\":" + (f.canvas_noise ? "true" : "false") +
                ",\"webglNoise\":" + (f.webgl_noise ? "true" : "false") + "}");
}

void NativeStore::RandomizeFingerprint() {
  static const char* kTimezones[] = {"UTC",          "Asia/Shanghai", "Asia/Tokyo",
                                     "Europe/London", "America/New_York"};
  static const char* kLanguages[] = {"zh-CN", "en-US", "ja-JP", "en-GB"};
  static const char* kScreens[] = {"1920x1080", "2560x1440", "1366x768", "1536x864", "3840x2160"};
  static const char* kCores[] = {"2", "4", "6", "8", "12", "16"};

  std::random_device rd;
  std::mt19937 rng(rd());
  auto pick = [&](const char* const* arr, size_t n) { return std::string(arr[rng() % n]); };

  fingerprint.timezone = pick(kTimezones, 5);
  fingerprint.language = pick(kLanguages, 4);
  fingerprint.screen = pick(kScreens, 5);
  fingerprint.hardware_concurrency = pick(kCores, 6);
  fingerprint.do_not_track = "1";
  fingerprint.canvas_noise = true;
  fingerprint.webgl_noise = true;
  SaveFingerprint();
  Log("无痕模式 2.0：指纹画像已随机化（时区 " + fingerprint.timezone + "，语言 " +
      fingerprint.language + "，屏幕 " + fingerprint.screen + "）");
}

void NativeStore::SaveAccounts() {
  std::vector<std::string> items;
  for (const AccountRecord& a : accounts) {
    items.push_back("{\"provider\":" + Quote(a.provider) + ",\"email\":" + Quote(a.email) +
                    ",\"displayName\":" + Quote(a.display_name) +
                    ",\"signedInAt\":" + std::to_string(a.signed_in_at) + "}");
  }
  WriteJson("accounts.json", ListToJson(items));
}

void NativeStore::SaveSync() {
  WriteJson("sync.json",
            "{\"enabled\":" + std::string(sync_enabled ? "true" : "false") +
                ",\"lastSyncAt\":" + std::to_string(last_sync_at) + ",\"toggles\":{" +
                "\"bookmarks\":" + (sync_toggles.bookmarks ? "true" : "false") +
                ",\"history\":" + (sync_toggles.history ? "true" : "false") +
                ",\"settings\":" + (sync_toggles.settings ? "true" : "false") +
                ",\"extensions\":" + (sync_toggles.extensions ? "true" : "false") +
                ",\"passwords\":" + (sync_toggles.passwords ? "true" : "false") + "}}");
}

bool NativeStore::SignIn(const std::string& provider, std::string& error) {
  if (provider != "microsoft" && provider != "google") {
    error = "不支持的账户类型：" + provider;
    return false;
  }
  // 诚实说明：真实的 OAuth 授权需要用户自备 client_id 并走浏览器授权页，
  // 由边车（service/src/ai/oauth.ts）实现。原生侧只负责记录登录态与驱动同步。
  CefRefPtr<CefCommandLine> cl = CefCommandLine::GetGlobalCommandLine();
  if (!cl || cl->GetSwitchValue("oauth-client-id").empty()) {
    error =
        "尚未配置 " + provider +
        " 的 OAuth client id。真实登录需要在启动参数中提供 --oauth-client-id=<你的应用ID>，"
        "并确保已在服务商侧登记回环回调地址；在此之前不会伪造登录成功。";
    return false;
  }
  for (AccountRecord& a : accounts) {
    if (a.provider == provider) {
      a.signed_in_at = NowSeconds();
      SaveAccounts();
      return true;
    }
  }
  AccountRecord a;
  a.provider = provider;
  a.email = "";
  a.display_name = provider == "microsoft" ? "Microsoft 账户" : "Google 账户";
  a.signed_in_at = NowSeconds();
  accounts.push_back(a);
  SaveAccounts();
  return true;
}

void NativeStore::SignOut(const std::string& provider) {
  const auto it = std::remove_if(accounts.begin(), accounts.end(),
                                 [&](const AccountRecord& a) { return a.provider == provider; });
  if (it != accounts.end()) {
    accounts.erase(it, accounts.end());
    SaveAccounts();
  }
}

void NativeStore::NoteBlocked() {
  ++blocked_total;
  ++blocked_last24h;
}

}  // namespace tib
