// TiBrowser 原生外壳 —— 公共头
// 版本：v1.0.0-rc1 (build 260913)
#pragma once

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_resource_handler.h"
#include "include/cef_scheme.h"
#include "include/cef_values.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_browser_view_delegate.h"
#include "include/views/cef_box_layout.h"
#include "include/views/cef_window.h"
#include "include/views/cef_window_delegate.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_message_router.h"
#include "include/wrapper/cef_stream_resource_handler.h"

#include <string>
#include <vector>

namespace tib {

/** 产品标识 */
inline constexpr char kAppName[] = "TiBrowser";
/** 自定义协议：tib://ui/** 提供浏览器外壳 UI，tib://newtab 提供新标签页 */
inline constexpr char kSchemeUi[] = "tib";
inline constexpr char kUiHost[] = "ui";
inline constexpr char kNewTabHost[] = "newtab";

/** 外壳（标签栏 + 地址栏 + 菜单）的高度，单位 DIP，必须与 shared/constants.ts 的 UI 常量一致 */
inline constexpr int kChromeHeight = 82;  // 标签栏 38 + 工具栏 44
inline constexpr int kBookmarkBarHeight = 30;
inline constexpr int kFindBarHeight = 40;
inline constexpr int kSidebarWidth = 360;

/** 一条标签页的可序列化状态（与 shared/types.ts 的 TabState 对齐） */
struct TabInfo {
  std::string id;
  std::string url;
  std::string title = "新标签页";
  std::string favicon;
  bool loading = false;
  bool can_go_back = false;
  bool can_go_forward = false;
  bool secure = true;
  bool is_new_tab = true;
  bool blocked = false;
  double zoom = 0.0;
};

/** 进程级单例：持有设置、窗口列表与 sidecar 客户端 */
class AppContext {
 public:
  static AppContext& Get();

  /** 当前是否处于无痕窗口（用于安全/历史策略） */
  bool incognito() const { return incognito_; }
  void set_incognito(bool v) { incognito_ = v; }

  /** 安全浏览档位：enhanced / standard / none */
  const std::string& protection_level() const { return protection_level_; }
  void set_protection_level(const std::string& v) { protection_level_ = v; }

  /** 能效模式：standard / fast / low / ondemand */
  const std::string& energy_mode() const { return energy_mode_; }
  void set_energy_mode(const std::string& v) { energy_mode_ = v; }

  /** 皮肤：tibrowser / edge / chrome */
  const std::string& skin() const { return skin_; }
  void set_skin(const std::string& v) { skin_ = v; }

  /** 程序所在目录（用于定位 ui/ 与 resources/） */
  const std::string& app_dir() const { return app_dir_; }
  void set_app_dir(const std::string& v) { app_dir_ = v; }

  /** 用户数据目录（Chromium profile 根） */
  const std::string& user_data_dir() const { return user_data_dir_; }
  void set_user_data_dir(const std::string& v) { user_data_dir_ = v; }

 private:
  bool incognito_ = false;
  std::string protection_level_ = "standard";
  std::string energy_mode_ = "standard";
  std::string skin_ = "tibrowser";
  std::string app_dir_;
  std::string user_data_dir_;
};

/** 生成一个短随机 id（标签页标识，不追求密码学强度） */
std::string MakeId();

/** 把任意用户输入解析成可导航的 URL（无协议时按搜索引擎搜索） */
std::string ResolveNavigationInput(const std::string& input, const std::string& search_engine);

/** 读取本地文件为字符串，失败返回空串 */
std::string ReadFileToString(const std::string& path);

/** 取可执行文件所在目录（不含结尾反斜杠） */
std::string ExecutableDir();

/** 简易日志：写入 stderr，同时追加到用户数据目录下的 tibrowser.log */
void Log(const std::string& message);

}  // namespace tib
