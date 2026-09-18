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

/** 上线调用前缀：必须与 src/bootstrap/index.ts 的 CALL_PREFIX 一致 */
constexpr char kHostCallPrefix[] = "__TIB_CALL__";

/**
 * 单次外壳状态采样任务。
 * 放在匿名命名空间内，避免污染 tib 命名空间；实现见文件末尾。
 */
class UiProbeTask : public CefTask {
 public:
  UiProbeTask(TibWindow* window, int round) : window_(window), round_(round) {}
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

  TibWindow* window_;
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
  // 注意：CefBrowserView::CreateBrowserView 返回的是**新创建**的引用；
  // 直接赋给 CefRefPtr 会触发 "Check failed: !needs_adopt_ref_" 断言，
  // 必须先取出裸指针，让 CefRefPtr 走 adopt 语义。
  // 委托必须是 PageViewDelegate（声明 Alloy 风格），否则视图会被窗口拒绝挂载。
  // 初始 URL 用 about:blank：tib:// 的 scheme handler 此刻尚未装好，直接给会报
  // ERR_UNKNOWN_URL_SCHEME（新标签页的真实入口在 OnTabCreated 里加载）。
  CefBrowserView* raw_view =
      CefBrowserView::CreateBrowserView(client, "about:blank", browser_settings, nullptr, context,
                                        new PageViewDelegate(this, id))
          .release();
  Log("CreateTab: BrowserView 已创建");
  tab->view = raw_view;

  if (!active_id_.empty() && content_view_) {
    content_view_->SetVisible(false);
  }
  if (!active_id_.empty()) {
    window_->RemoveChildView(content_view_);
  }

  active_id_ = id;
  content_view_ = raw_view;
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
  if (content_view_ && content_view_ != (*it)->view) {
    window_->RemoveChildView(content_view_);
  }
  active_id_ = tab_id;
  content_view_ = (*it)->view;
  window_->AddChildView(content_view_);
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

  // 设置快照：字段与 src/shared/bridge.ts 的 TibSettings 对齐
  CefRefPtr<CefDictionaryValue> settings = CefDictionaryValue::Create();
  settings->SetString("searchEngine", "bing");
  settings->SetString("homepage", "https://www.bing.com");
  settings->SetString("theme", "system");
  settings->SetString("skin", AppContext::Get().skin());
  settings->SetString("perf", "high");
  settings->SetBool("bookmarkBarVisible", true);
  settings->SetBool("showHomeButton", true);
  settings->SetBool("restoreSession", false);
  settings->SetString("cliPermission", "daily");
  settings->SetBool("aiEnabled", true);
  settings->SetBool("serviceAutoStart", true);
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
 */
class WindowActivateTask : public CefTask {
 public:
  explicit WindowActivateTask(TibWindow* window) : window_(window) {}
  void Execute() override {
    if (window_) window_->EnsureVisibleOnScreen();
  }

 private:
  TibWindow* window_;
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
  Log("OnTabCreated: 网页视图就绪 id=" + tab_id + " 视图已挂载=" +
      (((*it)->view != nullptr) ? "是" : "否"));
  if (!browser || !browser->GetMainFrame()) return;
  const std::string url =
      (*it)->pending_url.empty() ? NewTabUrl() : (*it)->pending_url;
  (*it)->pending_url.clear();
  (*it)->info.is_new_tab = (url.find("/ui/index.html#/newtab") != std::string::npos);
  Log("执行导航：" + url);
  browser->GetMainFrame()->LoadURL(url);
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
  // 同上：新建引用必须取出裸指针再交给 CefRefPtr（adopt 语义）
  //
  // 外壳 UI 走本地回环 HTTP：本机实测 tib:// 在 CefBrowserView 中始终返回
  // ERR_UNKNOWN_URL_SCHEME（详见 native/include/local_server.h）。
  // 初始 URL 用 about:blank，真正的入口在下面显式 LoadURL ——
  // CreateBrowserView 内部会立刻发起加载，那时上下文未必就绪。
  CefBrowserView* raw_chrome =
      CefBrowserView::CreateBrowserView(chrome_client_, "about:blank", chrome_settings, nullptr,
                                        nullptr, new ChromeViewDelegate(this))
          .release();
  chrome_view_ = raw_chrome;
  window->AddChildView(chrome_view_);
  Log("OnWindowCreated: 外壳 UI 视图已挂载");

  // 外壳 UI 的加载由 ChromeViewDelegate::OnBrowserCreated → OnChromeViewReady 负责，
  // 这里不再重复 LoadURL（重复加载会让 frame 变成 detached）。
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
  Log("OnWindowCreated: 创建首个标签页");
  CreateTab(first_tab_url, true);

  // --open=<url> 指定的附加标签页（自动化验证用）
  for (const std::string& extra : AppContext::Get().extra_urls()) {
    Log("按命令行要求打开附加标签页：" + extra);
    CreateTab(extra, true);
  }

  Layout();
  Log("OnWindowCreated: 布局完成");

  // 视图已挂载并完成布局，这时加载外壳 UI 才不会被丢弃
  LoadChromeUi();
}

void TibWindow::OnWindowDestroyed(CefRefPtr<CefWindow> window) {
  window_ = nullptr;
  chrome_view_ = nullptr;
  content_view_ = nullptr;
  for (auto& tab : tabs_) {
    if (tab->client) tab->client->Detach();
  }
  tabs_.clear();
  auto& windows = Windows();
  windows.erase(std::remove_if(windows.begin(), windows.end(),
                               [&](const CefRefPtr<TibWindow>& w) { return w.get() == this; }),
                windows.end());
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
  // 在这里加载是安全的：该回调发生在视图完成创建之后，主框架此时才真正可用。
  // 放在 OnWindowCreated 里会落在 detached frame 上被 CEF 丢弃（实测服务器收不到请求）。
  if (window_) window_->LoadChromeUi();
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