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

}  // namespace

struct TibWindow::Tab {
  std::string id;
  TabInfo info;
  CefRefPtr<CefBrowserView> view;
  CefRefPtr<PageClient> client;
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
  Log("CreateTab: PageClient 就绪");

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
  CefBrowserView* raw_view =
      CefBrowserView::CreateBrowserView(client, "tib://newtab", browser_settings, nullptr, context,
                                        this)
          .release();
  Log("CreateTab: BrowserView 已创建");
  tab->view = raw_view;
  tabs_.push_back(tab);
  Log("CreateTab: 已加入标签列表");

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

  if (!input.empty()) {
    Navigate(input);
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
  CefRefPtr<CefBrowser> chrome = chrome_browser();
  if (!chrome) return;
  CefRefPtr<CefProcessMessage> message = CefProcessMessage::Create("tib.event");
  CefRefPtr<CefListValue> args = message->GetArgumentList();
  args->SetSize(2);
  args->SetString(0, name);
  args->SetString(1, payload ? ToJson(payload) : "{}");
  chrome->GetMainFrame()->SendProcessMessage(PID_RENDERER, message);
}

void TibWindow::SyncState() {
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
    t->SetBool("blocked", info.blocked);
    t->SetDouble("zoomLevel", info.zoom);
    list->SetValue(i, AsValue(t));
  }
  root->SetValue("tabs", AsValue(list));
  root->SetString("activeTabId", active_id_);
  root->SetBool("isIncognito", incognito_);
  root->SetString("skin", AppContext::Get().skin());
  root->SetString("protectionLevel", AppContext::Get().protection_level());
  root->SetString("energyMode", AppContext::Get().energy_mode());
  SendEvent("state", AsValue(root));
}

void TibWindow::OnTabTitle(const std::string& tab_id, const std::string& title) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end()) return;
  (*it)->info.title = title.empty() ? "新标签页" : title;
  (*it)->info.is_new_tab = false;
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

void TibWindow::OnTabCreated(const std::string& tab_id, CefRefPtr<CefBrowser> browser,
                             CefRefPtr<PageClient> client) {
  const auto it = std::find_if(tabs_.begin(), tabs_.end(),
                               [&](const std::shared_ptr<Tab>& t) { return t->id == tab_id; });
  if (it == tabs_.end()) return;
  // 消息路由只服务外壳 UI；网页视图不开路由，避免网页调用内部 API
  (void)browser;
  (void)client;
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

  // 消息路由：服务外壳 UI 的 tib.* 查询（网页视图不挂，避免网页调用内部 API）
  router_ = CreateTibRouter();
  router_->AddHandler(CreateTibQueryHandler(), true);
  Log("OnWindowCreated: 消息路由已就绪");

  CefBrowserSettings chrome_settings;
  chrome_settings.background_color = kBgColor;
  chrome_client_ = new ChromeClient(this);
  chrome_client_->set_router(router_);
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

  // 首个标签页
  CreateTab("", true);
  Layout();
  Log("OnWindowCreated: 完成");
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

void TibWindow::OnBrowserCreated(CefRefPtr<CefBrowserView> browser_view,
                                 CefRefPtr<CefBrowser> browser) {
  if (browser_view == chrome_view_) {
    // 外壳 UI 就绪后推送一次状态
    SyncState();
  }
}

CefRefPtr<CefMessageRouterBrowserSide> TibWindow::EnsureRouter() {
  if (!router_) {
    CefMessageRouterConfig config;
    config.js_query_function = "tibQuery";
    config.js_cancel_function = "tibQueryCancel";
    router_ = CefMessageRouterBrowserSide::Create(config);
  }
  return router_;
}

// ---------------------------------------------------------------- 客户端实现

void ChromeClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  browser_ = browser;
  // 建立「外壳浏览器 → 窗口」反查，供消息路由分发使用
  RegisterWindowForChromeBrowser(browser, window_);
  if (window_) window_->SyncState();
}

bool ChromeClient::OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                           CefRefPtr<CefFrame> frame,
                                           CefProcessId source_process,
                                           CefRefPtr<CefProcessMessage> message) {
  if (router_ && router_->OnProcessMessageReceived(browser, frame, source_process, message)) {
    return true;
  }
  return false;
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
