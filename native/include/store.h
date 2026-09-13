// 原生轻量存储：设置、书签、历史、下载、网页应用、扩展、无痕指纹、账户。
//
// 设计取舍：这些数据的权威副本放在原生侧（浏览器知道真实的书签/历史/下载），
// AI 对话、MCP、OAuth、办公/开发模式放在 Node 边车（需要生态库）。
// 两边通过 ARCHITECTURE.md §4 的本地 RPC 交换，不重复造轮子。
//
// 存储格式：全部是 <userData>/ 下的 JSON 文件，UTF-8，原子写（临时文件 + rename）。
#pragma once

#include "tib_common.h"

namespace tib {

/** 书签一条 */
struct Bookmark {
  std::string id;
  std::string title;
  std::string url;
  std::string folder;
  int64_t created_at = 0;
};

/** 历史一条 */
struct HistoryEntry {
  std::string id;
  std::string title;
  std::string url;
  int64_t visited_at = 0;
};

/** 下载一条 */
struct DownloadRecord {
  std::string id;
  std::string filename;
  std::string url;
  std::string save_path;
  int64_t received = 0;
  int64_t total = 0;
  std::string state;  // progressing / completed / cancelled / interrupted
  bool suspicious = false;
  std::string suspicious_reason;
  int64_t started_at = 0;
};

/** 网页应用（feature 7） */
struct WebApp {
  std::string id;
  std::string name;
  std::string url;
  std::string icon;
  int64_t created_at = 0;
};

/** 扩展（feature 10 的扩展管理） */
struct ExtensionRecord {
  std::string id;
  std::string name;
  std::string version;
  std::string path;
  bool enabled = true;
  std::string description;
};

/** 无痕模式 2.0 的指纹画像（feature 4） */
struct FingerprintProfile {
  std::string user_agent = "跟随系统";
  std::string platform = "跟随系统";
  std::string timezone = "跟随系统";
  std::string language = "跟随系统";
  std::string screen = "跟随系统";
  std::string hardware_concurrency = "跟随系统";
  std::string do_not_track = "跟随系统";
  bool canvas_noise = true;
  bool webgl_noise = true;
};

/** 账户与同步（feature 3） */
struct AccountRecord {
  std::string provider;  // microsoft / google
  std::string email;
  std::string display_name;
  int64_t signed_in_at = 0;
};

struct SyncToggles {
  bool bookmarks = true;
  bool history = true;
  bool settings = true;
  bool extensions = false;
  bool passwords = false;
};

/** 设置（与 src/shared/bridge.ts 的 TibSettings 对齐） */
struct AppSettings {
  std::string search_engine = "bing";
  std::string homepage = "https://www.bing.com";
  std::string theme = "system";
  std::string skin = "tibrowser";
  std::string perf = "high";
  bool bookmark_bar_visible = true;
  bool show_home_button = true;
  bool restore_session = false;
  std::string cli_permission = "daily";
  bool ai_enabled = true;
  bool service_auto_start = true;
};

/**
 * 原生存储。
 * 所有写操作都是原子的（先写 .tmp 再 rename），避免崩溃时留下半个文件 ——
 * 这是 v0.1.0 的一个真实回归，rc1 不再重复。
 */
class NativeStore {
 public:
  static NativeStore& Get();

  /** 初始化：读取全部数据文件（幂等） */
  void Init();

  // ---- 设置 ----
  AppSettings settings;
  void SaveSettings();
  /** 设置变更后通知边车（best-effort，不阻塞） */
  void NotifySettingsChanged() const;

  // ---- 书签 ----
  std::vector<Bookmark> bookmarks;
  void SaveBookmarks();
  Bookmark AddBookmark(const std::string& title, const std::string& url,
                       const std::string& folder = "书签栏");
  bool RemoveBookmark(const std::string& id);
  /** 切换收藏状态，返回切换后是否已收藏 */
  bool ToggleBookmark(const std::string& title, const std::string& url);

  // ---- 历史 ----
  std::vector<HistoryEntry> history;
  void SaveHistory();
  void AddHistory(const std::string& title, const std::string& url);
  void ClearHistory();
  bool RemoveHistory(const std::string& id);

  // ---- 下载 ----
  std::vector<DownloadRecord> downloads;
  void SaveDownloads();
  void UpsertDownload(const DownloadRecord& record);

  // ---- 网页应用 ----
  std::vector<WebApp> apps;
  void SaveApps();
  WebApp AddApp(const std::string& name, const std::string& url, const std::string& icon);
  bool RemoveApp(const std::string& id);
  /** 找到网页应用；找不到返回 nullptr */
  const WebApp* FindApp(const std::string& id) const;

  // ---- 扩展 ----
  std::vector<ExtensionRecord> extensions;
  void SaveExtensions();
  bool RemoveExtension(const std::string& id);
  bool SetExtensionEnabled(const std::string& id, bool enabled);

  // ---- 无痕 2.0 / 指纹 ----
  FingerprintProfile fingerprint;
  void SaveFingerprint();
  void RandomizeFingerprint();

  // ---- 账户与同步 ----
  std::vector<AccountRecord> accounts;
  SyncToggles sync_toggles;
  bool sync_enabled = false;
  int64_t last_sync_at = 0;
  void SaveAccounts();
  void SaveSync();
  bool SignIn(const std::string& provider, std::string& error);
  void SignOut(const std::string& provider);

  // ---- 安全浏览统计 ----
  int64_t blocked_total = 0;
  int64_t blocked_last24h = 0;
  void NoteBlocked();

  /** 数据目录 */
  const std::string& dir() const { return dir_; }

 private:
  NativeStore() = default;
  std::string dir_;
  bool ready_ = false;

  /** 原子写：先写 <name>.tmp 再改名 */
  void WriteJson(const std::string& file, const std::string& json) const;
  std::string ReadJson(const std::string& file) const;
};

/** 生成一个短 id */
std::string NewId();

/** 当前时间（Unix 秒） */
int64_t NowSeconds();

/** JSON 转义（对外暴露给 router 使用） */
std::string JsonEscapePublic(const std::string& in);

}  // namespace tib
