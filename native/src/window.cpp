// 浏览器窗口实现：多标签、布局、事件回传
#include "window.h"

#include "router.h"
#include "scheme.h"
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

/** 上行调用前缀：必须与 src/bootstrap/index.ts 的 CALL_PREFIX 保持一致 */
constexpr char kHostCallPrefix[] = "__TIB_CALL__";

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

  // 每个标签页一个独立 BrowserView；无痕窗口使用内存态 RequestContext
  CefRefPtr<CefRequestContext> context;
  if (incognito_) {
    CefRequestContextSettings context_settings;
    context_settings.persist_session_cookies = false;
    context = CefRequestContext::CreateContext(context_settings, nullptr);
    ApplyFingerprintProfile(context);  // 无痕模式 2.0：注入指纹改写
  }

  CefBrowserSettings browser_settings;
  browser_settings.background_color = kBgColor;
  // 注意：CefBrowserView::CreateBrowserView 返回的是**新创建**的引用；
  // 直接赋给 CefRefPtr 会触发 "Check failed: !needs_adopt_ref_" 断言，
  // 必须先取出裸指针，让 CefRefPtr 走 adopt 语义。
  // 委托必须是 PageViewDelegate（声明 Alloy 风格），否则视图会被窗口拒绝挂载。
  CefBrowserView* raw_view =
      CefBrowserView::CreateBrowserView(client, "tib://newtab", browser_settings, nullptr, context,
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
  const CefRect bounds = window_->GetBoundsInScreen();
  CefRect client = window_->GetClientAreaBoundsInScreen();
  const int width = client.width;
  const int height = client.height;
  (void)bounds;

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
  if (chrome && chrome->GetMainFrame()) {
    chrome->GetMainFrame()->ExecuteJavaScript(js, chrome->GetMainFrame()->GetURL(), 0);
  }
}

void TibWindow::SyncState() {
  const std::string json = GetStateJson();
  RunInChrome("window.__tibDeliverEvent && window.__tibDeliverEvent('state', JSON.stringify(" + json +
              "))");
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
  // 浏览器此时才真正就绪，执行创建时挂起的首次导航
  if (!(*it)->pending_url.empty() && browser && browser->GetMainFrame()) {
    const std::string url = (*it)->pending_url;
    (*it)->pending_url.clear();
    (*it)->info.is_new_tab = false;
    Log("首个导航：" + url);
    browser->GetMainFrame()->LoadURL(url);
  }
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
  CefBrowserView* raw_chrome =
      CefBrowserView::CreateBrowserView(chrome_client_, "tib://ui/index.html", chrome_settings,
                                        nullptr, nullptr, this)
          .release();
  chrome_view_ = raw_chrome;
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
  // 首个标签页：命令行给了 --url= 就直接打开，否则新标签页
  CreateTab(AppContext::Get().startup_url(), true);
  Log("OnWindowCreated: 标签页已建");
  Layout();
  Log("OnWindowCreated: 布局完成");
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
  if (browser_view == chrome_view_) {
    // 外壳 UI 就绪后推送一次状态
    SyncState();
  }
}

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

bool ChromeClient::OnConsoleMessage(CefRefPtr<CefBrowser> browser,
                                    cef_log_severity_t level,
                                    const CefString& message,
                                    const CefString& source,
                                    int line) {
  (void)browser;
  (void)level;
  (void)source;
  (void)line;
  const std::string text = message.ToString();
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
