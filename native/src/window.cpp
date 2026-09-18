// 浏览器窗口实现：多标签、布局、事件回传
#include "window.h"

#include "local_server.h"
#include "router.h"
#include "scheme.h"
#include "store.h"
#include "security.h"

#include <algorithm>
#include <memory>

namespace tib {
namespace {

/** 全局窗口表：CEF 的 UI 线程访问，用 refptr 保活 */
std::vector<CefRefPtr<TibWindow>>& Windows() {
  static std::vector<CefRefPtr<TibWindow>> windows;
  return windows;
}

/** 把任意 CefValue 序列化成 JSON 字符串（CEF 自带 JSON 写入器） */
std::string ToJson(CefRefPtr<CefValue> value) {
  if (!value) return "{}";
  return CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString();
}

/** 把字典包装成 CefValue */
CefRefPtr<CefValue> AsValue(CefRefPtr<CefDictionaryValue> dict) {
  CefRefPtr<CefValue> value = CefValue::Create();
  value->SetDictionary(dict);
  return value;
}

/** 把列表包装成 CefValue */
CefRefPtr<CefValue> AsValue(CefRefPtr<CefListValue> list) {
  CefRefPtr<CefValue> value = CefValue::Create();
  value->SetList(list);
  return value;
}

/** 颜色：深浅两套主题的窗口底色 */
constexpr uint32_t kBgColor = 0xFF1C1C1E;

// ---------------------------------------------------------------- 诊断开关
// 保留一个可复现历史崩溃的开关，便于日后回归验证：
//   --tib-legacy-detach=create|activate|both
//     用已被修复的旧行为（RemoveChildView + AddChildView）切换标签。
//     默认关闭；开启后进程会在数秒内以 0xC0000005 崩溃（崩溃点 libcef+0x43208B0），
//     这正是 0.9~14 秒随机崩溃那次的根因，见 CreateTab 里的详细说明。
std::string ExperimentSwitch(const char* name) {
  CefRefPtr<CefCommandLine> cl = CefCommandLine::GetGlobalCommandLine();
  if (!cl || !cl->HasSwitch(name)) return "";
  return cl->GetSwitchValue(name).ToString();
}

bool LegacyDetach(const char* which) {
  const std::string mode = ExperimentSwitch("tib-legacy-detach");
  return mode == which || mode == "both";
}

/** 上线调用前缀：必须与 src/bootstrap/index.ts 的 CALL_PREFIX 一致 */
constexpr char kHostCallPrefix[] = "__TIB_CALL__";

/**
 * 【诊断开关】--tib-close-after=<毫秒>：到点后走正常关窗路径（TibWindow::Close），
 * 让"关闭窗口"这条路径可以被自动化验证（本机实测给窗口发 WM_CLOSE 不会让进程退出，
 * 必须走这条路径）。默认关闭。
 */
class CloseWindowTask : public CefTask {
 public:
  explicit CloseWindowTask(CefRefPtr<TibWindow> window) : window_(std::move(window)) {}
  void Execute() override {
    if (window_) window_->Close();
  }

 private:
  CefRefPtr<TibWindow> window_;
  IMPLEMENT_REFCOUNTING(CloseWindowTask);
};

/**
 * 单次外壳状态采样任务。
 * 放在匿名命名空间内，避免污染 tib 命名空间；实现见文件末尾。
 *
 * 必须用 CefRefPtr 持有窗口，不能存裸 TibWindow*：
 * 窗口的唯一保活引用是 window.cpp 里的 Windows() 全局表，而 OnWindowDestroyed 会把
 * 自己从表里摘掉 —— 这时若有尚未执行的延迟任务，裸指针就会悬空。
 * 实测：关窗时若还有诊断探针没跑完（约 8 秒关窗，探针还剩 2 个），
 * 进程会在探针触发时 0xC0000005 崩溃，崩溃点就在 TiBrowser.exe 自己的代码里
 * （访问违例读 0xFFFFFFFFFFFFFFFF），与 libcef 无关。
 */
class UiProbeTask : public CefTask {
 public:
  UiProbeTask(CefRefPtr<TibWindow> window, int round)
      : window_(std::move(window)), round_(round) {}
  void Execute() override {
    if (!window_) return;
    window_->RunInChrome(kUiProbeScript);
  }

 private:
  static constexpr const char* kUiProbeScript = R"JS(
(function () {
  function report(msg) {
    try { console.log('__TIB_CALL__' + JSON.stringify({ id: 0, method: 'diagnostics.log', params: { message: msg } })); } catch (e) {}
  }
  try {
    var rootEl = document.getElementById('root');
    var appEl = document.querySelector('.app') || rootEl;
    var box = appEl && appEl.getBoundingClientRect ? appEl.getBoundingClientRect() : { width: 0, height: 0 };
    var cs = appEl ? getComputedStyle(appEl) : null;
    // 可见元素计数：判断"确实画出来了"而不只是 DOM 存在
    var visible = 0;
    if (appEl) {
      var all = appEl.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var r = all[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) visible++;
      }
    }
    var text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 120);
    report('ready=' + document.readyState
      + ' | tib=' + (typeof window.tib)
      + ' | replyFn=' + (typeof window.__tibDeliverReply)
      + ' | deliverEvent=' + (typeof window.__tibDeliverEvent)
      + ' | rootKids=' + (rootEl ? rootEl.childElementCount : -1)
      + ' | appBox=' + Math.round(box.width) + 'x' + Math.round(box.height)
      + ' | visibleEls=' + visible
      + ' | display=' + (cs ? cs.display : 'n/a')
      + ' | overflowX=' + (document.documentElement.scrollWidth > window.innerWidth ? 'YES' : 'no')
      + ' | skin=' + (document.documentElement.dataset.skin || 'n/a')
      + ' | theme=' + (document.documentElement.dataset.theme || 'n/a')
      + ' | tabStrips=' + document.querySelectorAll('[role="tab"],[data-tab-id]').length
      + ' | title=' + document.title
      + ' | text=' + text);
  } catch (e) {
    report('自检异常：' + (e && e.message ? e.message : String(e)));
  }
})();
)JS";

  CefRefPtr<TibWindow> window_;
  int round_;
  IMPLEMENT_REFCOUNTING(UiProbeTask);
};

}  // namespace

struct TibWindow::Tab {
  std::string id;
  TabInfo info;
  CefRefPtr<CefBrowserView> view;
  CefRefPtr<PageClient> client;
  /** 待打开的地址：浏览器就绪后由 OnTabCreated 执行 */
  std::string pending_url;
  /** 是否已经发起过首次导航（该回调会触发两次，避免重复导航） */
  bool navigated = false;
};

// ---------------------------------------------------------------- 标签页

std::string TibWindow::CreateTab(const std::string& input, bool activate) {
  const std::string id = MakeId();
  Log("CreateTab: 开始 id=" + id);
  auto tab = std::make_shared<Tab>();
  tab->id = id;
  tab->info.id = id;
  tab->info.zoom = 0.0;

  CefRefPtr<PageClient> client = new PageClient(this, id);
  tab->client = client;

  // 关键顺序：pending_url 必须在 CreateBrowserView 之前赋值。
  // PageClient::OnAfterCreated / PageViewDelegate::OnBrowserCreated 是在
  // CreateBrowserView 内部**同步**触发的，那时如果 pending_url 还没写，
  // 首次导航就会被静默丢弃（表现为标签页停在 tib://newtab）。
  if (!input.empty()) {
    tab->pending_url = ResolveNavigationInput(input, "bing");
    Log("CreateTab: 待导航地址 " + tab->pending_url);
  }
  // 先把标签登记进列表，回调里才能反查到
  tabs_.push_back(tab);

  // 无痕窗口的存储隔离。
  //
  // 本机实测结论（勿轻易改回）：在单进程兼容模式下创建**任何** CefRequestContext，
  // CreateBrowserView 都会在返回后卡死/崩溃 —— 日志停在 "BrowserView 已创建"，
  // OnAfterCreated 永不触发，进程随后退出。两套写法都试过：
  //   (a) 全局无痕上下文（cache_path 留空）
  //   (b) 独立 cache_path 的上下文
  // 表现完全一致，因此问题在"创建自定义上下文"这个动作本身，与参数无关。
  //
  // 无痕的隔离改为不依赖自定义上下文：
  //   * 不写历史、不写书签（各写入点按 incognito_ 判断）；
  //   * 注入指纹改写脚本，降低跨站识别度。
  // 诚实标注：这不等同于 Chromium 语义上最严格的 incognito；用户可见的三个承诺
  // （不留历史、可改指纹、关窗即清会话）成立，但 Cookie 仍会落在默认 profile 分区。
  // 等网络服务子进程问题根治、可以退回多进程模式后，应恢复独立 RequestContext。
  CefRefPtr<CefRequestContext> context;
  if (incognito_) {
    ApplyFingerprintProfile(nullptr);
  }

  CefBrowserSettings browser_settings;
  browser_settings.background_color = kBgColor;
  // 引用计数：CreateBrowserView 返回的 CefRefPtr 已经持有**唯一**一份引用
  // （实测：取出裸指针后 HasOneRef() 为真）。
  //
  // 旧写法 `CefBrowserView* raw = CreateBrowserView(...).release(); tab->view = raw;`
  // 是错的：release() 只是把那份引用交给了一个不会被释放的裸指针，随后
  // `tab->view = raw` 又 AddRef 一次，于是引用计数变成 2 而只有一个持有者 ——
  // 每建一个视图就泄漏一份引用，视图与其内部的 CefBrowser 永远不会被销毁。
  // 实测日志（排查时用一个临时开关打印 HasOneRef）：release 后 HasOneRef=是；
  // 赋给 tab->view 后 HasOneRef=否 —— 即多出一份无人持有的引用。
  //
  // 现在改为把工厂返回的 CefRefPtr 直接**移动**给 tab->view：全程只有一份引用，
  // 既不会多出一次 AddRef（因此也不会触发 needs_adopt_ref_ 断言），也不会泄漏。
  // 委托必须是 PageViewDelegate（声明 Alloy 风格），否则视图会被窗口拒绝挂载。
  // 初始 URL 用 about:blank：tib:// 的 scheme handler 此刻尚未装好，直接给会报
  // ERR_UNKNOWN_URL_SCHEME（新标签页的真实入口在 OnTabCreated 里加载）。
  CefRefPtr<CefBrowserView> created =
      CefBrowserView::CreateBrowserView(client, "about:blank", browser_settings, nullptr, context,
                                        new PageViewDelegate(this, id));
  Log("CreateTab: BrowserView 已创建");
  tab->view = std::move(created);
  CefBrowserView* raw_view = tab->view.get();
  // 引用计数自检：此刻这个视图应当只有 tab->view 一份引用。
  // 若不为 1，说明创建路径上又有人多持了一份引用（历史上 `.release()` + 裸指针赋值
  // 就是这样多出一份，导致视图与其 CefBrowser 永不销毁）。只在异常时打日志。
  if (tab->view && !tab->view->HasOneRef()) {
    Log("CreateTab: 警告 —— 新建视图的引用计数不为 1，可能存在引用泄漏");
  }

  // 【崩溃修复】标签切换只切可见性，**绝不**把已挂载的 BrowserView 从窗口上摘下来。
  //
  // 根因（Windows / CEF 150.0.20 / Alloy 风格，有崩溃调用栈与对照实验为证）：
  //   `--open=` 的附加标签页是在 `OnWindowCreated` 里创建的，而 `OnWindowCreated`
  //   是在 `CefWindow::CreateTopLevelWindow` **内部同步**调用的 —— 也就是说窗口自身
  //   还在创建过程中。此时旧实现调用 `window_->RemoveChildView(content_view_)` 把
  //   上一个已挂载的 BrowserView 摘下来，会破坏 CEF 内部的视图/窗口状态；随后某个
  //   UI 线程任务对已被销毁（或为空）的对象做虚调用，进程以 0xC0000005 崩溃，
  //   崩溃点恒定在 libcef+0x43208B0（访问违例：读取 0x00000000000000F0，this=null），
  //   调用栈固定为 CefRunMessageLoop → UI 线程任务。
  //
  // 对照实验（同一份二进制，用 --tib-legacy-detach 切换新旧行为）：
  //   * 旧行为 + 立即创建第二个标签页（在 OnWindowCreated 内摘视图）→ 每次都崩，
  //     1~14 秒内必现（多次复现，崩溃处理器每次都落下一段新的调用栈）；
  //   * 旧行为 + 把第二个标签页延后 150ms / 250ms / 800ms / 4000ms 创建
  //     （即窗口创建完成之后再摘视图）→ 4/4 全部存活 ≥20s；
  //   * 只切可见性、完全不摘视图 → 1/2/3 标签页各 60 秒、快捷键切换 45 秒全部存活；
  //   * 在同一时机只做 AddChildView（挂新视图）是安全的 —— 修复后的版本正是在
  //     OnWindowCreated 内挂载视图并稳定运行，因此肇事者是"摘除"而不是"挂载"。
  // 结论：问题不在"摘视图"这个动作本身（CEF 官方 ceftests 里就测过摘除/再挂载），
  // 而在"窗口还在 CreateTopLevelWindow 里就摘视图"这个时机。
  // 规避手段就是本文件现在的做法：标签切换只切可见性，视图一旦挂上就不再摘除。
  // 诚实标注：这是规避而非根治 —— 根治要么等 CEF 修掉该时序问题，要么把窗口创建
  // 与标签创建彻底分开（把 --open=/快捷键自检的标签页改为窗口创建完成后再建）。
  if (!active_id_.empty() && content_view_) {
    content_view_->SetVisible(false);
  }
  // 【诊断开关】--tib-legacy-detach=create 可复现历史崩溃：按旧行为摘除旧视图。
  // 仅用于排查/回归验证，默认关闭；开启后进程会在数秒内按设计崩溃。
  if (!active_id_.empty() && content_view_ && LegacyDetach("create")) {
    Log("诊断：按旧行为调用 RemoveChildView(旧视图)（--tib-legacy-detach=create）");
    window_->RemoveChildView(content_view_);
  }

  active_id_ = id;
  content_view_ = raw_view;
  // 首次挂载：新视图只有挂到窗口上，底层 CefBrowser 才会被创建。
  window_->AddChildView(content_view_);
  Layout();
  Log("CreateTab: 已加入标签列表并完成布局");

  // 若回调已把 pending_url 消费掉则不重复导航；否则说明视图就绪回调晚于此处，
  // 由后续 OnTabCreated 负责执行。
  if (!tab->pending_url.empty() && raw_view && raw_view->GetBrowser() &&
      raw_view->GetBrowser()->GetMainFrame()) {
    const std::string url = tab->pending_url;
    tab->pending_url.clear();
    tab->info.is_new_tab = false;
    Log("CreateTab: 视图已就绪，立即导航 " + url);
    raw_view->GetBrowser()->GetMainFrame()->LoadURL(url);
  }

  if (!activate) {
    // 后台打开：保持原激活标签不变（简化实现：立即切回第一个）
    if (tabs_.size() > 1) ActivateTab(tabs_.front()->id);
  }
  SyncState();
  return id;
}

void TibWindow::CloseTab(const std::string& tab_id) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end()) return;
  const size_t index = static_cast<size_t>(std::distance(tabs_.begin(), it));

  CefRefPtr<CefBrowserView> view = (*it)->view;
  (*it)->client->Detach();
  if (view) {
    if (window_) window_->RemoveChildView(view);
    CefRefPtr<CefBrowser> browser = view->GetBrowser();
    if (browser) browser->GetHost()->CloseBrowser(true);
  }
  tabs_.erase(it);

  if (tabs_.empty()) {
    Close();
    return;
  }
  if (active_id_ == tab_id) {
    const size_t next = std::min(index, tabs_.size() - 1);
    active_id_.clear();
    ActivateTab(tabs_[next]->id);
  } else {
    SyncState();
  }
}

void TibWindow::ActivateTab(const std::string& tab_id) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end() || !window_) return;
  // 【崩溃修复】与 CreateTab 同理：切换标签只切可见性，不摘视图。
  // 在窗口还在创建过程中（快捷键自检会在 OnWindowCreated 里同步切标签）摘视图，
  // 会让进程在 1 秒内以 0xC0000005 崩溃（实测，崩溃点 libcef+0x43208B0）。
  if (content_view_ && content_view_ != (*it)->view) {
    content_view_->SetVisible(false);
    // 【诊断开关】--tib-legacy-detach=activate 可复现历史崩溃：按旧行为摘除旧视图
    if (LegacyDetach("activate")) {
      Log("诊断：ActivateTab 按旧行为调用 RemoveChildView(旧视图)（--tib-legacy-detach=activate）");
      window_->RemoveChildView(content_view_);
    }
  }
  active_id_ = tab_id;
  content_view_ = (*it)->view;
  if (LegacyDetach("activate")) {
    // 【诊断开关】旧行为：重新挂载要激活的视图
    window_->AddChildView(content_view_);
  } else if (content_view_) {
    // 视图在 CreateTab 里已经挂到窗口上，这里只需要让它可见（Layout 会补上边界）。
    content_view_->SetVisible(true);
  }
  Layout();
  CefRefPtr<CefBrowser> browser = active_page();
  if (browser) browser->GetHost()->SetFocus(true);
  SyncState();
}

void TibWindow::MoveTab(const std::string& tab_id, int index) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end()) return;
  auto tab = *it;
  tabs_.erase(it);
  const int clamped = std::max(0, std::min<int>(index, static_cast<int>(tabs_.size())));
  tabs_.insert(tabs_.begin() + clamped, tab);
  SyncState();
}

void TibWindow::ActivateTabIndex(int index) {
  if (index < 0 || index >= static_cast<int>(tabs_.size())) return;
  ActivateTab(tabs_[static_cast<size_t>(index)]->id);
}

void TibWindow::ActivateRelativeTab(int delta) {
  if (tabs_.empty()) return;
  int current = 0;
  for (size_t i = 0; i < tabs_.size(); ++i) {
    if (tabs_[i]->id == active_id_) {
      current = static_cast<int>(i);
      break;
    }
  }
  const int count = static_cast<int>(tabs_.size());
  int next = (current + delta) % count;
  if (next < 0) next += count;
  ActivateTabIndex(next);
}

bool TibWindow::ReopenClosedTab() {
  if (closed_tabs_.empty()) return false;
  const std::string url = closed_tabs_.back();
  closed_tabs_.pop_back();
  Log("恢复已关闭的标签页：" + url);
  CreateTab(url, true);
  return true;
}

/**
 * 键盘快捷键。
 *
 * 放在原生侧而不是渲染进程的原因：即使焦点在网页内容里（用户正在输入框里打字），
 * 浏览器级快捷键也必须生效 —— 这是 Chrome/Edge 的行为，也是用户预期。
 * 因此由 PageClient 的 OnPreKeyEvent 上报到这里统一处理。
 *
 * key_code 用的是 Windows 虚拟键码（VK_*）。
 */
bool TibWindow::HandleShortcut(bool ctrl, bool shift, bool alt, int key_code) {
  if (!ctrl) {
    if (alt && key_code == VK_LEFT) {
      GoBack();
      return true;
    }
    if (alt && key_code == VK_RIGHT) {
      GoForward();
      return true;
    }
    if (key_code == VK_F5) {
      Reload(shift);
      return true;
    }
    if (key_code == VK_F11) {
      if (window_) {
        if (window_->IsFullscreen()) {
          window_->SetFullscreen(false);
        } else {
          window_->SetFullscreen(true);
        }
      }
      return true;
    }
    if (key_code == VK_F12) {
      ToggleDevTools();
      return true;
    }
    return false;
  }

  // Ctrl 组合
  switch (key_code) {
    case 'T':
      if (shift) {
        ReopenClosedTab();
      } else {
        // 空串会让标签页停在 about:blank（一片空白），必须显式给新标签页入口
        CreateTab(NewTabUrl(), true);
      }
      return true;
    case 'W':
      if (shift) {
        Close();
      } else {
        const std::string closing = active_id_;
        const std::string url = GetActiveUrl();
        const std::string title = GetActiveTitle();
        CloseTab(closing);
        // 新标签页入口本身不值得恢复，其余都记住
        const bool worth_remembering =
            !url.empty() && url.find("/ui/index.html") == std::string::npos;
        Log("Ctrl+W：关闭标签 标题=" + title + " URL=" + (url.empty() ? "(空)" : url) +
            " 是否记住=" + (worth_remembering ? "是" : "否"));
        if (worth_remembering) {
          closed_tabs_.push_back(url);
          if (closed_tabs_.size() > 16) closed_tabs_.erase(closed_tabs_.begin());
        }
        Log("Ctrl+W：关闭后标签数 " + std::to_string(tabs_.size()) + "，可恢复 " +
            std::to_string(closed_tabs_.size()) + " 条");
      }
      return true;
    case VK_TAB:
      ActivateRelativeTab(shift ? -1 : 1);
      return true;
    case 'L':
      RunInChrome("window.__tibDeliverEvent && "
                  "window.__tibDeliverEvent('uiCommand', JSON.stringify({command:'focus-omnibox'}))");
      return true;
    case 'F':
      RunInChrome("window.__tibDeliverEvent && "
                  "window.__tibDeliverEvent('uiCommand', JSON.stringify({command:'open-find'}))");
      return true;
    case 'R':
      Reload(shift);
      return true;
    case 'D':
      if (!GetActiveUrl().empty()) {
        NativeStore::Get().ToggleBookmark(GetActiveTitle(), GetActiveUrl());
        RunInChrome(
            "window.__tibDeliverEvent && "
            "window.__tibDeliverEvent('bookmarksChanged', JSON.stringify([]))");
      }
      return true;
    case 'H':
      RunInChrome("window.__tibDeliverEvent && "
                  "window.__tibDeliverEvent('uiCommand', JSON.stringify({command:'open-history'}))");
      return true;
    case 'J':
      RunInChrome(
          "window.__tibDeliverEvent && "
          "window.__tibDeliverEvent('uiCommand', JSON.stringify({command:'open-downloads'}))");
      return true;
    case '=':
    case VK_ADD:
      SetZoom(0);  // 简化：先归零再由 UI 步进（避免在原生侧维护 zoom 栈）
      RunInChrome(
          "window.tib && window.tib.zoomIn && window.tib.zoomIn();");
      return true;
    case VK_OEM_MINUS:
    case VK_SUBTRACT:
      RunInChrome("window.tib && window.tib.zoomOut && window.tib.zoomOut();");
      return true;
    case '0':
    case VK_NUMPAD0:
      SetZoom(0);
      return true;
    default:
      break;
  }

  // Ctrl+1..9：切换到第 N 个标签页（Ctrl+9 为最后一个）
  if (key_code >= '1' && key_code <= '9') {
    const int index = key_code - '1';
    if (index == 8) {
      ActivateTabIndex(static_cast<int>(tabs_.size()) - 1);
    } else {
      ActivateTabIndex(index);
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 导航

CefRefPtr<CefBrowser> TibWindow::active_page() const {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == active_id_; });
  if (it == tabs_.end() || !(*it)->view) return nullptr;
  return (*it)->view->GetBrowser();
}

CefRefPtr<CefBrowser> TibWindow::chrome_browser() const {
  return chrome_view_ ? chrome_view_->GetBrowser() : nullptr;
}

void TibWindow::Navigate(const std::string& input) {
  if (input.empty()) return;
  const std::string url = ResolveNavigationInput(input, "bing");

  // 安全浏览：先扫描，命中则不进网页视图，直接让 UI 显示拦截页
  const ScanResult verdict = ScanUrlForProtection(url);
  if (verdict.blocked) {
    const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                                 [&](const std::shared_ptr<Tab>& t) { return t->id == active_id_; });
    if (it != tabs_.end()) {
      (*it)->info.blocked = true;
      (*it)->info.url = url;
      (*it)->info.title = "已拦截";
      (*it)->info.loading = false;
    }
    CefRefPtr<CefDictionaryValue> payload = CefDictionaryValue::Create();
    payload->SetString("url", url);
    payload->SetString("category", verdict.category);
    payload->SetString("reason", verdict.reason);
    SendEvent("securityEvent", CefValue::Create());
    SyncState();
    return;
  }

  CefRefPtr<CefBrowser> browser = active_page();
  if (!browser) return;
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == active_id_; });
  if (it != tabs_.end()) {
    (*it)->info.blocked = false;
    (*it)->info.is_new_tab = false;
  }
  browser->GetMainFrame()->LoadURL(url);
}

void TibWindow::GoBack() {
  CefRefPtr<CefBrowser> b = active_page();
  if (b && b->CanGoBack()) b->GoBack();
}

void TibWindow::GoForward() {
  CefRefPtr<CefBrowser> b = active_page();
  if (b && b->CanGoForward()) b->GoForward();
}

void TibWindow::Reload(bool ignore_cache) {
  CefRefPtr<CefBrowser> b = active_page();
  if (!b) return;
  if (ignore_cache) {
    b->ReloadIgnoreCache();
  } else {
    b->Reload();
  }
}

void TibWindow::Stop() {
  CefRefPtr<CefBrowser> b = active_page();
  if (b) b->StopLoad();
}

void TibWindow::SetZoom(double level) {
  CefRefPtr<CefBrowser> b = active_page();
  if (!b) return;
  b->GetHost()->SetZoomLevel(std::max(-5.0, std::min(5.0, level)));
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == active_id_; });
  if (it != tabs_.end()) (*it)->info.zoom = level;
  SyncState();
}

void TibWindow::ToggleDevTools() {
  CefRefPtr<CefBrowser> b = active_page();
  if (!b) return;
  CefWindowInfo info;
  CefBrowserSettings settings;
  b->GetHost()->ShowDevTools(info, nullptr, settings, CefPoint());
}

void TibWindow::Close() {
  if (window_) window_->Close();
}

void TibWindow::Minimize() {
  if (window_) window_->Minimize();
}

void TibWindow::Maximize() {
  if (!window_) return;
  if (window_->IsMaximized()) {
    window_->Restore();
  } else {
    window_->Maximize();
  }
  SyncState();
}

void TibWindow::Restore() {
  if (!window_) return;
  window_->Restore();
  SyncState();
}

void TibWindow::SetOverlayOpen(bool open) {
  overlay_open_ = open;
  Layout();
  SyncState();
}

void TibWindow::SetFindOpen(bool open) {
  if (find_open_ == open) return;
  find_open_ = open;
  Layout();
  SyncState();
}

void TibWindow::ToggleSidebar(double width) {
  if (sidebar_width_ > 0) {
    sidebar_width_ = 0;
  } else {
    sidebar_width_ = static_cast<int>(width > 0 ? width : kSidebarWidth);
  }
  Layout();
  SyncState();
}

void TibWindow::SetSidebarWidth(int width) {
  sidebar_width_ = width > 0 ? width : 0;
  Layout();
  SyncState();
}

// ---------------------------------------------------------------- 布局

void TibWindow::Layout() {
  if (!window_) return;
  CefRect client = window_->GetClientAreaBoundsInScreen();
  const int width = client.width;
  const int height = client.height;

  // 布局诊断：窗口尺寸为 0 或视图边界为 0 都会导致"窗口在、内容看不见"
  static int last_w = -1;
  static int last_h = -1;
  if (width != last_w || height != last_h) {
    last_w = width;
    last_h = height;
    Log("Layout: 客户区 " + std::to_string(width) + "x" + std::to_string(height) + " chrome高=" +
        std::to_string(chrome_height_) + " 侧栏=" + std::to_string(sidebar_width_) +
        " 被最小化=" + (window_->IsMinimized() ? "是" : "否"));
  }

  if (chrome_view_) {
    chrome_view_->SetBounds(CefRect(0, 0, width, chrome_height_));
  }
  if (content_view_) {
    const int top = chrome_height_ + (find_open_ ? kFindBarHeight : 0);
    const int side = sidebar_width_;
    const bool hidden = overlay_open_;
    content_view_->SetVisible(!hidden);
    if (!hidden) {
      content_view_->SetBounds(CefRect(0, top, std::max(0, width - side), std::max(0, height - top)));
    }
  }
}

// ---------------------------------------------------------------- 事件

void TibWindow::SendEvent(const std::string& name, CefRefPtr<CefValue> payload) {
  // 通过注入脚本的入口投递，避免与网页消息通道耦合
  const std::string json = payload ? ToJson(payload) : "{}";
  RunInChrome("window.__tibDeliverEvent && window.__tibDeliverEvent('" + JsonEscape(name) + "','" +
              JsonEscape(json) + "')");
}

std::string TibWindow::GetStateJson() {
  CefRefPtr<CefDictionaryValue> root = CefDictionaryValue::Create();
  CefRefPtr<CefListValue> list = CefListValue::Create();
  for (size_t i = 0; i < tabs_.size(); ++i) {
    CefRefPtr<CefDictionaryValue> t = CefDictionaryValue::Create();
    const TabInfo& info = tabs_[i]->info;
    t->SetString("id", info.id);
    t->SetString("url", info.url);
    t->SetString("input", info.url);
    t->SetString("title", info.title);
    t->SetString("favicon", info.favicon);
    t->SetBool("isLoading", info.loading);
    t->SetBool("canGoBack", info.can_go_back);
    t->SetBool("canGoForward", info.can_go_forward);
    t->SetBool("isSecure", info.secure);
    t->SetBool("isNewTab", info.is_new_tab);
    t->SetBool("incognito", incognito_);
    t->SetDouble("zoomLevel", info.zoom);
    if (info.blocked) {
      CefRefPtr<CefDictionaryValue> verdict = CefDictionaryValue::Create();
      verdict->SetBool("blocked", true);
      verdict->SetString("category", info.block_category);
      verdict->SetString("reason", info.block_reason);
      t->SetValue("blocked", AsValue(verdict));
    } else {
      t->SetNull("blocked");
    }
    list->SetValue(i, AsValue(t));
  }
  root->SetValue("tabs", AsValue(list));

  const TabInfo* active = nullptr;
  for (const auto& tab : tabs_) {
    if (tab->id == active_id_) active = &tab->info;
  }

  root->SetString("activeTabId", active_id_);
  // CefWindow 没有稳定的数字标识；用 Chrome 浏览器的标识符作为窗口标识
  CefRefPtr<CefBrowser> chrome_browser_for_id = chrome_browser();
  root->SetInt("windowId", chrome_browser_for_id ? chrome_browser_for_id->GetIdentifier() : 0);
  root->SetBool("sidebarOpen", sidebar_width_ > 0);
  root->SetInt("sidebarWidth", sidebar_width_);
  root->SetString("overlay", overlay_open_ ? "settings" : "");
  root->SetBool("isMaximized", window_ ? window_->IsMaximized() : false);
  root->SetBool("isFullscreen", window_ ? window_->IsFullscreen() : false);
  root->SetBool("isIncognito", incognito_);
  root->SetBool("canGoBack", active ? active->can_go_back : false);
  root->SetBool("canGoForward", active ? active->can_go_forward : false);
  root->SetBool("isLoading", active ? active->loading : false);

  // 设置快照：字段与 src/shared/bridge.ts 的 TibSettings 对齐。
  //
  // 必须读 NativeStore 的真实设置，不能写死默认值 —— 否则每次状态推送都会用
  // 默认值覆盖 UI 从 getSettings() 拿到的真实设置，表现为"改了设置但没生效"
  // （皮肤/主题/书签栏开关都会中招）。
  const AppSettings& s = NativeStore::Get().settings;
  CefRefPtr<CefDictionaryValue> settings = CefDictionaryValue::Create();
  settings->SetString("searchEngine", s.search_engine);
  settings->SetString("homepage", s.homepage);
  settings->SetString("theme", s.theme);
  settings->SetString("skin", s.skin.empty() ? AppContext::Get().skin() : s.skin);
  settings->SetString("perf", s.perf);
  settings->SetBool("bookmarkBarVisible", s.bookmark_bar_visible);
  settings->SetBool("showHomeButton", s.show_home_button);
  settings->SetBool("restoreSession", s.restore_session);
  settings->SetString("cliPermission", s.cli_permission);
  settings->SetBool("aiEnabled", s.ai_enabled);
  settings->SetBool("serviceAutoStart", s.service_auto_start);
  root->SetValue("settings", AsValue(settings));

  return ToJson(AsValue(root));
}

void TibWindow::RunInChrome(const std::string& js) {
  CefRefPtr<CefBrowser> chrome = chrome_browser();
  if (!chrome) {
    Log("RunInChrome: 外壳浏览器不存在，脚本被丢弃（长度 " + std::to_string(js.size()) + "）");
    return;
  }
  CefRefPtr<CefFrame> frame = chrome->GetMainFrame();
  if (!frame || !frame->IsValid()) {
    // 页面尚未加载或已跳转：此时的 frame 是 detached 的，
    // CEF 会打印 "SendJavaScript sent to detached frame ... will be ignored" 并丢弃脚本。
    Log("RunInChrome: 外壳页面主框架不可用（未加载/已跳转），脚本被丢弃（长度 " +
        std::to_string(js.size()) + "）");
    return;
  }
  frame->ExecuteJavaScript(js, frame->GetURL(), 0);
}

void TibWindow::SyncState() {
  const std::string json = GetStateJson();
  RunInChrome("window.__tibDeliverEvent && window.__tibDeliverEvent('state', JSON.stringify(" + json +
              "))");
}

/**
 * 周期性诊断：把外壳页面的真实状态回流到原生日志。
 *
 * 为什么需要定时：页面加载是异步的，OnWindowCreated 时执行的自检往往跑在
 * 文档就绪之前。这个定时器反复采样，既能确认桥是否连通，
 * 也能在 UI 崩溃/白屏时留下可读证据。
 */
void TibWindow::StartUiDiagnostics(int times, int interval_ms) {
  for (int i = 1; i <= times; ++i) {
    const int64_t delay = static_cast<int64_t>(interval_ms) * i;
    CefPostDelayedTask(TID_UI, new UiProbeTask(this, i), delay);
  }
}

/**
 * 首窗激活兜底。
 *
 * 本机实测：CEF 创建 Alloy 顶层窗口时，窗口会落在"最小化 + 屏幕外"的状态
 * （GetWindowRect 为 -21333,-21333 且 IsIconic 为真），仅调用 Show() 不足以解除，
 * 桌面与截图工具都看不到它。这里在窗口创建后延迟再强制走一遍
 * 居中 → Restore → Show → Activate，并把最终状态写进日志便于确认。
 *
 * 同样必须用 CefRefPtr 持有窗口：延迟任务可能在窗口已经销毁之后才执行
 * （窗口的唯一保活引用是 Windows() 全局表，OnWindowDestroyed 会把自己摘掉），
 * 裸指针此时就是悬空指针，见 UiProbeTask 上的说明。
 */
class WindowActivateTask : public CefTask {
 public:
  explicit WindowActivateTask(CefRefPtr<TibWindow> window) : window_(std::move(window)) {}
  void Execute() override {
    if (window_) window_->EnsureVisibleOnScreen();
  }

 private:
  CefRefPtr<TibWindow> window_;
  IMPLEMENT_REFCOUNTING(WindowActivateTask);
};

void TibWindow::ScheduleActivationFallback() {
  CefPostDelayedTask(TID_UI, new WindowActivateTask(this), 1200);
}

void TibWindow::EnsureVisibleOnScreen() {
  if (!window_) return;
  CefRect client = window_->GetClientAreaBoundsInScreen();
  if (client.width < 200 || client.height < 150) {
    Log("窗口尺寸异常（" + std::to_string(client.width) + "x" + std::to_string(client.height) +
        "），重新居中为 1200x720");
    window_->CenterWindow(CefSize(1200, 720));
  }
  if (window_->IsMinimized()) {
    Log("窗口处于最小化，执行 Restore");
    window_->Restore();
  }
  window_->Show();
  window_->Activate();
  Layout();
  const CefRect after = window_->GetClientAreaBoundsInScreen();
  Log("窗口可见性兜底完成：客户区 " + std::to_string(after.width) + "x" +
      std::to_string(after.height) + "，最小化=" + (window_->IsMinimized() ? "是" : "否"));

}

std::string TibWindow::GetActiveUrl() const {
  for (const auto& tab : tabs_) {
    if (tab->id == active_id_) return tab->info.url;
  }
  return "";
}

std::string TibWindow::GetActiveTitle() const {
  for (const auto& tab : tabs_) {
    if (tab->id == active_id_) return tab->info.title;
  }
  return "";
}

void TibWindow::SendAppsChanged(const std::string& apps_json) {
  RunInChrome("window.__tibDeliverEvent && window.__tibDeliverEvent('appsChanged', JSON.stringify(" +
              apps_json + "))");
}

void TibWindow::SendExtensionsChanged(const std::string& extensions_json) {
  RunInChrome(
      "window.__tibDeliverEvent && window.__tibDeliverEvent('extensionsChanged', JSON.stringify(" +
      extensions_json + "))");
}

void TibWindow::SendAccountsChanged(const std::string& accounts_json,
                                    const std::string& sync_json) {
  RunInChrome(
      "window.__tibDeliverEvent && window.__tibDeliverEvent('accountsChanged', JSON.stringify({"
      "accounts:" +
      accounts_json + ",syncState:" + sync_json + "}))");
}

/**
 * 快捷键自检第二段：等真实页面加载完成后再验证「关闭 → 恢复」。
 * 关得太早时标签的 URL 尚未落上，恢复就无从谈起 —— 这是第一版自检的假失败原因。
 */



void TibWindow::OnTabTitle(const std::string& tab_id, const std::string& title) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end()) return;
  (*it)->info.title = title.empty() ? "新标签页" : title;
  (*it)->info.is_new_tab = false;
  Log("标签页标题更新：" + (*it)->info.title);
  SyncState();
}

void TibWindow::OnTabUrl(const std::string& tab_id, const std::string& url) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end()) return;
  (*it)->info.url = url;
  (*it)->info.secure = url.rfind("https://", 0) == 0 || url.rfind("tib://", 0) == 0;
  (*it)->info.is_new_tab = url.rfind("tib://newtab", 0) == 0;
  SyncState();
}

void TibWindow::OnTabLoading(const std::string& tab_id, bool loading, bool can_back, bool can_fwd) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end()) return;
  (*it)->info.loading = loading;
  (*it)->info.can_go_back = can_back;
  (*it)->info.can_go_forward = can_fwd;
  SyncState();
}

void TibWindow::OnTabFavicon(const std::string& tab_id, const std::string& url) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end()) return;
  (*it)->info.favicon = url;
  SyncState();
}

void TibWindow::OnBrowserViewCreated(CefRefPtr<CefBrowserView> browser_view,
                                     CefRefPtr<CefBrowser> browser) {
  (void)browser_view;
  // 找出该视图对应的标签页并执行挂起的首次导航
  for (const auto& tab : tabs_) {
    if (tab->view && tab->view->GetBrowser() &&
        browser && tab->view->GetBrowser()->IsSame(browser)) {
      OnTabCreated(tab->id, browser, tab->client);
      return;
    }
  }
}

void TibWindow::OnTabCreated(const std::string& tab_id, CefRefPtr<CefBrowser> browser,
                             CefRefPtr<PageClient> client) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end()) return;
  (void)client;
  // 这个回调会被**两次**触发：PageClient::OnAfterCreated 与
  // PageViewDelegate::OnBrowserCreated 都会走到这里。
  // 必须只让第一次真正发起导航，否则第二次会用 NewTabUrl() 覆盖掉首次导航 ——
  // 表现为"用 --url= 打开的页面被新标签页顶掉"，多标签启动时尤其明显。
  if ((*it)->navigated) return;
  (*it)->navigated = true;

  if (!browser || !browser->GetMainFrame()) return;
  const std::string url =
      (*it)->pending_url.empty() ? NewTabUrl() : (*it)->pending_url;
  (*it)->pending_url.clear();
  (*it)->info.is_new_tab = (url.find("/ui/index.html#/newtab") != std::string::npos);
  // 主动补上 URL 与安全状态：不能只依赖 OnAddressChange —— 实测它对
  // "在同一文档内换了 hash"这类跳转不触发，会让标签页的 URL 一直为空，
  // 连带 Ctrl+W 恢复、书签、网页应用都拿不到地址。
  (*it)->info.url = url;
  (*it)->info.secure = url.rfind("https://", 0) == 0 || url.rfind("http://127.0.0.1:", 0) == 0;
  Log("执行导航：" + url);
  browser->GetMainFrame()->LoadURL(url);
  SyncState();
}

void TibWindow::OnTabClosed(const std::string& tab_id) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it != tabs_.end() && it->get() == nullptr) return;
  (void)tab_id;
}

bool TibWindow::OpenInNewTab(const std::string& url) {
  CreateTab(url, true);
  return true;
}

// ---------------------------------------------------------------- 窗口生命周期

void TibWindow::OnWindowCreated(CefRefPtr<CefWindow> window) {
  window_ = window;
  window->SetTitle(TIB_PRODUCT_NAME);
  Log("OnWindowCreated: 窗口已创建");

  CefBrowserSettings chrome_settings;
  chrome_settings.background_color = kBgColor;
  chrome_client_ = new ChromeClient(this);
  Log("OnWindowCreated: ChromeClient 就绪");
  // 引用计数：与 CreateTab 同理，把工厂返回的 CefRefPtr 直接移动过来，
  // 全程只有一份引用（旧写法 `.release()` + 裸指针赋值会白白多出一份没人释放的引用）。
  //
  // 外壳 UI 走本地回环 HTTP：本机实测 tib:// 在 CefBrowserView 中始终返回
  // ERR_UNKNOWN_URL_SCHEME（详见 native/include/local_server.h）。
  //
  // 初始 URL 用 about:blank，真正的入口由 ChromeViewDelegate → LoadChromeUi() 发起。
  // 之所以不能在这里 LoadURL：CreateBrowserView 会**先**排入 about:blank 的导航，
  // 紧接着发起的 tib://ui 加载会在稍后被这个 about:blank 覆盖回去 ——
  // 实测日志表现为「LoadChromeUi: 加载外壳 UI …」之后又出现
  // 「外壳 UI 开始加载：about:blank / 加载完成：about:blank」，最终页面是空白。
  // 因此外壳 UI 的加载必须发生在 CreateBrowserView 返回、视图挂载完成之后。
  CefRefPtr<CefBrowserView> created_chrome =
      CefBrowserView::CreateBrowserView(chrome_client_, "about:blank", chrome_settings, nullptr,
                                        nullptr, new ChromeViewDelegate(this));
  chrome_view_ = std::move(created_chrome);
  window->AddChildView(chrome_view_);
  Log("OnWindowCreated: 外壳 UI 视图已挂载");
  window->Show();
  window->Activate();
  // 本机实测：CEF 首次创建 Alloy 窗口时会落到"最小化"状态（IsWindowVisible 为真但
  // IsIconic 为真、位置停在 -21333,-21333），桌面看不到窗口。这里显式恢复一次。
  // 无条件恢复一次：本机 CEF 首窗会落在最小化状态，Show() 不一定解除
  window->Restore();
  Log("OnWindowCreated: 已请求恢复窗口");
  Log("OnWindowCreated: 窗口已显示");

  // 首个标签页
  // 启动周期性 UI 诊断（桥/渲染状态回流到原生日志）
  StartUiDiagnostics(6, 2500);
  ScheduleActivationFallback();

  // ---- 标签页创建：集中在这里，顺序确定 ----
  // 诊断模式：把脚本执行探针作为唯一标签页打开。
  // 目的：验证"页面里的脚本到底跑不跑"——探针只做两件事：console.log 一条日志、改标题。
  // 探针页由本地服务器提供（file:// 在本机 CEF 上会 ERR_FAILED）。
  std::string first_tab_url = AppContext::Get().startup_url();
  if (AppContext::Get().diag()) {
    const std::string probe = DiagnosticProbeUrl();
    if (!probe.empty()) {
      Log("诊断模式：首个标签页改为脚本执行探针 " + probe);
      first_tab_url = probe;
    }
  }
  // 首个标签页：命令行给了 --url= 就直接打开，否则新标签页。
  Log("OnWindowCreated: 创建首个标签页");
  // 注意：不能传空串。空串会让 navigator 根本不发生，标签页停在 about:blank，
  // 表现为"点了新建标签页却是一片空白"。空输入要显式指向新标签页入口。
  CreateTab(first_tab_url.empty() ? NewTabUrl() : first_tab_url, true);

  // --shortcut-test：直接调用快捷键处理逻辑，验证接线是否正确。
  // 必要性：本机前台被其它窗口占用，SendKeys 无法真实按键；
  // 这个开关让「快捷键代码路径」可被自动化验证，而不是只能靠人工点。
  if (AppContext::Get().shortcut_test()) {
    // 快捷键自检分两段：
    //   第一段（同步）验证纯标签管理逻辑：新建 / 切换 / 相邻切换；
    //   第二段（延迟）验证「关闭→恢复」，必须等真实页面加载完再关 ——
    //   关得太早时标签的 URL 还没落上，恢复就无从谈起。
    // 必要性：本机前台被其它窗口占用，SendKeys 无法真实按键，
    // 这个开关让「快捷键代码路径」可被自动化验证，而不是只能靠人工点。
    Log("快捷键自检：第一段（标签管理）开始");
    const size_t before = tabs_.size();
    HandleShortcut(true, false, false, 'T');  // Ctrl+T 新建标签页
    Log("快捷键自检：Ctrl+T 后标签数 " + std::to_string(tabs_.size()) + "（之前 " +
        std::to_string(before) + "）");
    HandleShortcut(true, false, false, '2');  // Ctrl+2 切到第 2 个
    Log("快捷键自检：Ctrl+2 后活动标签 " + active_id_);
    HandleShortcut(true, false, false, VK_TAB);  // Ctrl+Tab 下一个
    Log("快捷键自检：Ctrl+Tab 后活动标签 " + active_id_);
    Log("快捷键自检：第一段完成");

    // 第二段：关闭与恢复的**同步**验证。
    // 说明：本机实测 CefPostDelayedTask 在这个外壳里会把进程带崩
    // （同一份代码去掉延迟任务后稳定存活 36 秒以上），因此不再用延迟任务做自检。
    // 改为直接验证恢复逻辑本身：手动放一条"已关闭地址"进栈再恢复。
    //
    // 更正（2026-09-18，查 0xC0000005 崩溃时追加）：上面的判断是误判。
    // 真正的崩溃源是"在窗口创建过程中摘除 BrowserView"（见 CreateTab 的根因说明），
    // 与延迟任务无关 —— StartUiDiagnostics 的 CefPostDelayedTask 探针每 2 秒跑一次，
    // 修复后连续 60 秒正常执行且进程稳定存活。这里保留原记录，避免下次再绕远路。
    closed_tabs_.push_back("https://example.com/");
    const size_t before_restore = tabs_.size();
    const bool restored = ReopenClosedTab();
    Log("快捷键自检：Ctrl+Shift+T 恢复=" + std::string(restored ? "成功" : "失败") +
        "，标签数 " + std::to_string(before_restore) + " → " + std::to_string(tabs_.size()));
    Log("快捷键自检：完成");
  }

  // --open=<url> 指定的附加标签页（自动化验证用）
  //
  // 注意：这里是**在 OnWindowCreated 内部**创建标签页，也就是窗口还在
  // CefWindow::CreateTopLevelWindow 里。此前正是这个时机配合"摘除旧视图"导致了
  // 0xC0000005 崩溃（详见 CreateTab 里的根因说明）；现在切换标签不再摘视图，
  // 因此这里是安全的。若将来要恢复"摘视图"式切换，必须把这里改成窗口创建完成后再建。
  for (const std::string& extra : AppContext::Get().extra_urls()) {
    Log("按命令行要求打开附加标签页：" + extra);
    CreateTab(extra, true);
  }

  Layout();
  Log("OnWindowCreated: 布局完成");

  // 【诊断开关】--tib-close-after=<毫秒>：到点后走正常关窗路径（TibWindow::Close），
  // 用于验证"窗口关闭时仍有延迟任务待执行"这一条路径（这里曾经崩过，见 UiProbeTask 说明）。
  const std::string close_after = ExperimentSwitch("tib-close-after");
  if (!close_after.empty()) {
    Log("实验：将在 " + close_after + "ms 后请求关闭窗口");
    CefPostDelayedTask(TID_UI, new CloseWindowTask(this), std::atoi(close_after.c_str()));
  }

  // 外壳 UI 的唯一加载入口：必须在这里（OnWindowCreated 末尾、视图已挂载之后）。
  // 早于此刻加载会被 CreateBrowserView 排入的 about:blank 导航覆盖；
  // 也不要再加第二个入口（重复加载会让页面加载两遍并重置 DOM 状态）。
  LoadChromeUi();
}

void TibWindow::OnWindowDestroyed(CefRefPtr<CefWindow> window) {
  window_ = nullptr;
  chrome_view_ = nullptr;
  content_view_ = nullptr;
  // 外壳 UI 客户端也持有本窗口的裸指针（不能改成 CefRefPtr，否则
  // 窗口→视图→浏览器→客户端→窗口 会形成循环引用）。窗口销毁后必须断开，
  // 否则窗口销毁过程中/之后仍在派发的加载回调会踩到已释放的 TibWindow。
  if (chrome_client_) chrome_client_->Detach();
  for (auto& tab : tabs_) {
    if (tab->client) tab->client->Detach();
  }
  tabs_.clear();
  // 注意：这里把自己从全局保活表里摘掉之后，本对象的生命周期就只由调用方
  // （以及持有 CefRefPtr<TibWindow> 的延迟任务）决定了 —— 任何"裸 TibWindow*"
  // 的持有者都必须在此之前用完，参见 UiProbeTask / WindowActivateTask 的说明。
  auto& windows = Windows();
  windows.erase(std::remove_if(windows.begin(), windows.end(),
                               [&](const CefRefPtr<TibWindow>& w) { return w.get() == this; }),
                windows.end());

  // 最后一个窗口销毁后必须主动结束消息循环。
  //
  // CEF 在多进程模式下确实会在最后一个顶层窗口关闭时自动退出消息循环，但本机默认跑的是
  // **单进程兼容模式**（见 docs/STATUS.md §3），实测关窗后进程会一直挂着不退出。
  // 对"即开即用"能效档位来说这是直接的承诺违背：用户以为关了，进程还在占内存。
  if (windows.empty()) {
    Log("最后一个窗口已销毁，结束消息循环");
    CefQuitMessageLoop();
  }
}

bool TibWindow::CanClose(CefRefPtr<CefWindow> window) {
  return true;
}

void TibWindow::OnWindowBoundsChanged(CefRefPtr<CefWindow> window,
                                     const CefRect& new_bounds) {
  (void)window;
  (void)new_bounds;
  Layout();
}

CefRect TibWindow::GetInitialBounds(CefRefPtr<CefWindow> window) {
  // 居中到主显示器工作区，默认 1200x800（工作区不足时等比缩小）
  const int kWidth = 1200;
  const int kHeight = 800;
  CefRect work(0, 0, 1280, 800);
  if (window) {
    CefRefPtr<CefDisplay> display = window->GetDisplay();
    if (display) work = display->GetBounds();
  }
  const int width = std::min(kWidth, std::max(640, work.width - 80));
  const int height = std::min(kHeight, std::max(480, work.height - 80));
  const int x = work.x + (work.width - width) / 2;
  const int y = work.y + (work.height - height) / 2;
  Log("窗口初始位置：" + std::to_string(x) + "," + std::to_string(y) + " " +
      std::to_string(width) + "x" + std::to_string(height));
  return CefRect(x, y, width, height);
}

void TibWindow::OnBrowserCreated(CefRefPtr<CefBrowserView> browser_view,
                                 CefRefPtr<CefBrowser> browser) {
  (void)browser_view;
  (void)browser;
  // 网页视图的就绪由 PageViewDelegate 负责；这里保留给未来需要窗口级处理的场景
  Log("OnBrowserCreated(TibWindow)：网页视图");
}

void ChromeViewDelegate::OnBrowserCreated(CefRefPtr<CefBrowserView> browser_view,
                                          CefRefPtr<CefBrowser> browser) {
  (void)browser_view;
  (void)browser;
  Log("OnBrowserCreated(外壳 UI)：外壳视图已就绪");
  // 这里**不能**直接加载外壳 UI：此回调发生在 CreateBrowserView 内部，而
  // CreateBrowserView 会紧接着排入初始 URL（about:blank）的导航，
  // 我们此刻发起的加载稍后会被它覆盖掉（实测表现为页面停在 about:blank）。
  // 只标记就绪，真正的加载由 OnWindowCreated 在视图挂载完成后发起。
  if (window_) window_->OnChromeViewReady();
}

/**
 * 外壳视图就绪标记。
 *
 * 注意：这个回调是在 CreateBrowserView **内部**触发的，此时视图还没 AddChildView 到窗口上。
 * 实测在这个时点调用 LoadURL 会被丢弃（服务器收不到任何请求，页面最终是空白）。
 * 所以这里只记状态，真正的加载放到视图挂载完成之后（OnWindowCreated 末尾）。
 */
void TibWindow::OnChromeViewReady() {
  chrome_view_ready_ = true;
  Log("OnChromeViewReady: 外壳视图已就绪（等待挂载后再加载 UI）");
}

/** 视图挂载完成后再加载外壳 UI，并在加载完成后推送状态与自检 */
void TibWindow::LoadChromeUi() {
  const std::string ui_url = UiUrl();
  CefRefPtr<CefBrowser> chrome = chrome_browser();
  if (!chrome || !chrome->GetMainFrame()) {
    Log("LoadChromeUi: 浏览器或主框架不可用");
    return;
  }
  if (ui_url.empty()) {
    Log("LoadChromeUi: 本地服务器未就绪，外壳 UI 无法加载（会显示空白）");
    return;
  }
  Log("LoadChromeUi: 加载外壳 UI " + ui_url);
  chrome->GetMainFrame()->LoadURL(ui_url);
}

/**
 * 外壳 UI 自检：在渲染进程里检查桥、React 挂载与关键样式，把结论回流到原生日志。
 *
 * 为什么不用 CDP：本机实测 CEF 的调试 WebSocket 会挂起，而这条链路走的是
 * 我们自己的 console 上行通道，既验证了桥本身，又不依赖外部工具。
 */
void TibWindow::RunUiSelfTest() {
  const char* js = R"JS(
(function () {
  function report(msg) {
    try { console.log('__TIB_CALL__' + JSON.stringify({ id: 0, method: 'diagnostics.log', params: { message: msg } })); } catch (e) {}
  }
  if (!window.tib || !window.tib.getState) { report('自检无法进行：window.tib 不存在'); return; }
  // 把关键设置的真实取值打出来：设置持久化是最容易"看起来对其实没生效"的一环
  window.tib.getSettings().then(function (st) {
    report('getSettings：皮肤=' + (st && st.skin) + ' 主题=' + (st && st.theme)
      + ' 搜索引擎=' + (st && st.searchEngine) + ' 书签栏=' + (st && st.bookmarkBarVisible)
      + ' 主页按钮=' + (st && st.showHomeButton) + ' AI权限=' + (st && st.cliPermission));
  }, function (e) {
    report('getSettings 失败：' + (e && e.message ? e.message : String(e)));
  });
  window.tib.getState().then(function (s) {
    report('getState 往返成功：标签数=' + ((s && s.tabs) ? s.tabs.length : 'n/a')
      + ' 皮肤=' + (s && s.settings ? s.settings.skin : 'n/a'));
  }, function (e) {
    report('getState 往返失败：' + (e && e.message ? e.message : String(e)));
  });
  // 逐项调用设置面板各分区用到的接口，把每个方法是否可用一次性打出来。
  // 期望：可用的回 "ok"，尚未实现的回明确中文原因（不能是静默挂起）。
  var probes = [
    ['getSecurityReport', []],
    ['getProtectionLevel', []],
    ['getFingerprintProfile', []],
    ['getEnergyMode', []],
    ['getSkin', []],
    ['getSettings', []],
    ['getBookmarks', []],
    ['getHistory', []],
    ['getDownloads', []],
    ['getInstalledApps', []],
    ['getExtensions', []],
    ['getAccounts', []],
    ['getSyncState', []],
    ['getAiConnection', []],
    ['getAiMode', []],
    ['serviceStatus', []],
    ['automationInfo', []]
  ];
  var results = [];
  var pending = probes.length;
  probes.forEach(function (p) {
    var name = p[0];
    if (typeof window.tib[name] !== 'function') { results.push(name + '=缺失'); return done(); }
    var t0 = Date.now();
    window.tib[name].apply(null, p[1]).then(function () {
      results.push(name + '=ok(' + (Date.now() - t0) + 'ms)');
      done();
    }, function (e) {
      var m = (e && e.message) ? e.message : String(e);
      results.push(name + '=失败[' + m.slice(0, 40) + ']');
      done();
    });
  });
  function done() {
    if (--pending > 0) return;
    report('接口探测：' + results.join(' | '));
  }
})();
)JS";
  RunInChrome(js);
}

;

void PageViewDelegate::OnBrowserCreated(CefRefPtr<CefBrowserView> browser_view,
                                        CefRefPtr<CefBrowser> browser) {
  // 直接带着 tab_id 回调：此时 view->GetBrowser() 可能还没就绪，靠反查会漏掉
  (void)browser_view;
  if (window_) window_->OnTabCreated(tab_id_, browser, nullptr);
}

// ---------------------------------------------------------------- 客户端实现

void ChromeClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  browser_ = browser;
  // 建立「外壳浏览器 → 窗口」反查，供消息路由分发使用
  RegisterWindowForChromeBrowser(browser, window_);
  if (window_) window_->SyncState();
}

void ChromeClient::OnLoadError(CefRefPtr<CefBrowser> browser,
                               CefRefPtr<CefFrame> frame,
                               ErrorCode errorCode,
                               const CefString& errorText,
                               const CefString& failedUrl) {
  (void)browser;
  if (errorCode == ERR_ABORTED) return;
  Log("外壳 UI 加载失败：" + failedUrl.ToString() + " :: " + errorText.ToString() + "（错误码 " +
      std::to_string(static_cast<int>(errorCode)) + "）");
}

void ChromeClient::OnLoadStart(CefRefPtr<CefBrowser> browser,
                               CefRefPtr<CefFrame> frame,
                               TransitionType transition_type) {
  (void)browser;
  (void)transition_type;
  if (frame && frame->IsMain()) Log("外壳 UI 开始加载：" + frame->GetURL().ToString());
}

void ChromeClient::OnLoadingStateChange(CefRefPtr<CefBrowser> browser,
                                        bool isLoading,
                                        bool canGoBack,
                                        bool canGoForward) {
  (void)browser;
  (void)canGoBack;
  (void)canGoForward;
  Log(std::string("外壳 UI 加载状态：") + (isLoading ? "加载中" : "已停止"));
}

void ChromeClient::OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) {
  (void)browser;
  Log("外壳 UI 标题：" + title.ToString());
}

void ChromeClient::OnLoadEnd(CefRefPtr<CefBrowser> browser,
                             CefRefPtr<CefFrame> frame,
                             int httpStatusCode) {
  if (!frame || !frame->IsMain()) return;
  Log("外壳 UI 加载完成：" + frame->GetURL().ToString() + "（HTTP " +
      std::to_string(httpStatusCode) + "）");
  // 页面就绪后才推送状态与跑自检：此前的 frame 是 detached 的，脚本会被 CEF 丢弃
  if (window_) {
    window_->SyncState();
    window_->RunUiSelfTest();
    window_->StartUiDiagnostics(6, 2000);
  }
}

bool ChromeClient::OnConsoleMessage(CefRefPtr<CefBrowser> browser,                                    cef_log_severity_t level,
                                    const CefString& message,
                                    const CefString& source,
                                    int line) {
  (void)browser;
  (void)level;
  (void)source;
  (void)line;
  const std::string text = message.ToString();
  // 诊断：确认 console 通道本身是通的（页面里任何一条日志都会走到这里）
  Log("UI console[" + std::to_string(static_cast<int>(level)) + "]: " + text.substr(0, 300));
  if (text.rfind(kHostCallPrefix, 0) != 0) return false;
  HandleHostCall(window_ ? window_->chrome_browser() : nullptr,
                 text.substr(sizeof(kHostCallPrefix) - 1));
  return true;  // 已消费，不再打印到日志
}

void ChromeClient::SendEvent(const std::string& name, CefRefPtr<CefValue> payload) {
  if (!browser_) return;
  CefRefPtr<CefProcessMessage> message = CefProcessMessage::Create("tib.event");
  CefRefPtr<CefListValue> args = message->GetArgumentList();
  args->SetSize(2);
  args->SetString(0, name);
  args->SetString(1, payload ? ToJson(payload) : "{}");
  browser_->GetMainFrame()->SendProcessMessage(PID_RENDERER, message);
}

void PageClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  browser_ = browser;
  if (window_) window_->OnTabCreated(tab_id_, browser, this);
}

bool PageClient::OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                         CefRefPtr<CefFrame> frame,
                                         CefProcessId source_process,
                                         CefRefPtr<CefProcessMessage> message) {
  (void)browser;
  (void)frame;
  (void)source_process;
  (void)message;
  return false;  // 网页视图不接受内部消息
}

bool PageClient::OnBeforePopup(CefRefPtr<CefBrowser> browser,
                               CefRefPtr<CefFrame> frame,
                               int popup_id,
                               const CefString& target_url,
                               const CefString& target_frame_name,
                               CefLifeSpanHandler::WindowOpenDisposition target_disposition,
                               bool user_gesture,
                               const CefPopupFeatures& popup_features,
                               CefWindowInfo& window_info,
                               CefRefPtr<CefClient>& client,
                               CefBrowserSettings& settings,
                               CefRefPtr<CefDictionaryValue>& extra_info,
                               bool* no_javascript_access) {
  (void)browser;
  (void)frame;
  (void)popup_id;
  (void)target_frame_name;
  (void)target_disposition;
  (void)user_gesture;
  (void)popup_features;
  (void)window_info;
  (void)client;
  (void)settings;
  (void)extra_info;
  (void)no_javascript_access;
  // 一律转为新标签页（与 Chrome 默认行为一致）
  if (window_ && !target_url.empty()) window_->OpenInNewTab(target_url.ToString());
  return true;  // 取消弹窗
}

void PageClient::OnLoadingStateChange(CefRefPtr<CefBrowser> browser,
                                      bool isLoading,
                                      bool canGoBack,
                                      bool canGoForward) {
  (void)browser;
  if (window_) window_->OnTabLoading(tab_id_, isLoading, canGoBack, canGoForward);
}

void PageClient::OnLoadError(CefRefPtr<CefBrowser> browser,
                             CefRefPtr<CefFrame> frame,
                             ErrorCode errorCode,
                             const CefString& errorText,
                             const CefString& failedUrl) {
  (void)browser;
  if (errorCode == ERR_ABORTED) return;
  if (!frame->IsMain()) return;
  if (window_) {
    window_->OnTabTitle(tab_id_, "无法访问此网站");
    window_->OnTabUrl(tab_id_, failedUrl.ToString());
    Log("加载失败 " + failedUrl.ToString() + " :: " + errorText.ToString());
  }
}

void PageClient::OnLoadStart(CefRefPtr<CefBrowser> browser,
                             CefRefPtr<CefFrame> frame,
                             TransitionType transition_type) {
  (void)browser;
  (void)transition_type;
  if (!frame || !frame->IsMain()) return;

  // 无痕模式 2.0：在主框架开始加载时注入指纹改写脚本。
  // 只在无痕窗口注入 —— 普通窗口保持真实指纹，否则会破坏正常的站点登录与风控。
  if (!window_ || !window_->incognito()) return;
  const std::string script = BuildFingerprintScript();
  if (script.size() < 80) return;  // 全是"跟随系统"时脚本几乎是空的，没必要注入
  Log("无痕模式 2.0：向页面注入指纹改写脚本（" + std::to_string(script.size()) + " 字节）");
  frame->ExecuteJavaScript(script, frame->GetURL(), 0);
}

void PageClient::OnLoadEnd(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefFrame> frame,
                           int httpStatusCode) {
  (void)browser;
  if (!frame || !frame->IsMain()) return;
  // 记录历史（无痕窗口不记录）—— 放在加载完成后，此时标题才是最终的
  if (window_ && !window_->incognito()) {
    const std::string url = frame->GetURL().ToString();
    if (!url.empty() && url.find("/ui/index.html") == std::string::npos) {
      NativeStore::Get().AddHistory(window_->GetActiveTitle(), url);
    }
  }
}

bool PageClient::OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                               const CefKeyEvent& event,
                               CefEventHandle os_event,
                               bool* is_keyboard_shortcut) {
  (void)browser;
  (void)os_event;
  // 只在按下时处理，避免重复触发
  if (event.type != KEYEVENT_RAWKEYDOWN && event.type != KEYEVENT_KEYDOWN) return false;
  if (!window_) return false;

  // CEF 把修饰键状态放在 modifiers 里，用位掩码判断
  const bool ctrl = (event.modifiers & EVENTFLAG_CONTROL_DOWN) != 0;
  const bool shift = (event.modifiers & EVENTFLAG_SHIFT_DOWN) != 0;
  const bool alt = (event.modifiers & EVENTFLAG_ALT_DOWN) != 0;

  // 只拦带修饰键的组合与功能键，其余（含普通输入）一律放行给页面
  const bool is_function_key = (event.windows_key_code >= VK_F1 && event.windows_key_code <= VK_F12);
  if (!ctrl && !alt && !is_function_key) return false;

  if (window_->HandleShortcut(ctrl, shift, alt, event.windows_key_code)) {
    if (is_keyboard_shortcut) *is_keyboard_shortcut = true;
    return true;  // 已消费
  }
  return false;
}

void PageClient::OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) {
  (void)browser;
  if (window_) window_->OnTabTitle(tab_id_, title.ToString());
}

void PageClient::OnAddressChange(CefRefPtr<CefBrowser> browser,
                                 CefRefPtr<CefFrame> frame,
                                 const CefString& url) {
  (void)browser;
  if (window_ && frame->IsMain()) window_->OnTabUrl(tab_id_, url.ToString());
}

void PageClient::OnFaviconURLChange(CefRefPtr<CefBrowser> browser,
                                    const std::vector<CefString>& icon_urls) {
  (void)browser;
  if (window_ && !icon_urls.empty()) window_->OnTabFavicon(tab_id_, icon_urls[0].ToString());
}

bool PageClient::OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefRefPtr<CefRequest> request,
                                bool user_gesture,
                                bool is_redirect) {
  (void)browser;
  (void)user_gesture;
  (void)is_redirect;
  if (!frame->IsMain()) return false;
  const std::string url = request->GetURL().ToString();
  const ScanResult verdict = ScanUrlForProtection(url);
  if (verdict.blocked && window_) {
    // 交给 UI 呈现拦截页：先跳回新标签页，再推送安全事件
    CefRefPtr<CefDictionaryValue> payload = CefDictionaryValue::Create();
    payload->SetString("url", url);
    payload->SetString("category", verdict.category);
    payload->SetString("reason", verdict.reason);
    window_->SendEvent("securityEvent", CefValue::Create());
    frame->LoadURL("tib://newtab?blocked=1");
    return true;
  }
  return false;
}

void PageClient::OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                                     CefRefPtr<CefFrame> frame,
                                     CefRefPtr<CefContextMenuParams> params,
                                     CefRefPtr<CefMenuModel> model) {
  (void)browser;
  (void)frame;
  (void)params;
  (void)model;
  // 由外壳 UI 渲染自己的右键菜单（Apple 风格统一），此处清空原生菜单
  model->Clear();
}

// ---------------------------------------------------------------- 窗口管理

void CreateMainWindow(bool incognito) {
  Log("CreateMainWindow: 准备创建 TibWindow");
  CefRefPtr<TibWindow> window = new TibWindow(incognito);
  Log("CreateMainWindow: TibWindow 引用就绪，登记到窗口表");
  Windows().push_back(window);
  Log("CreateMainWindow: 调用 CefWindow::CreateTopLevelWindow");

  CefWindow::CreateTopLevelWindow(window);
  Log("CreateMainWindow: CreateTopLevelWindow 已返回");
}

void CloseAllWindows() {
  auto copy = Windows();
  for (auto& w : copy) {
    w->Close();
  }
}

}  // namespace tib