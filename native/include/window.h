// 浏览器窗口：多标签模型 + Views 布局（外壳 UI 在上，网页视图在下）
#pragma once

#include "tib_common.h"

namespace tib {

class TibWindow;

/**
 * 外壳 UI 浏览器（tib://ui）的客户端。
 * 上行调用不走 CEF 的 CefMessageRouter（本机会触发内部断言崩溃），
 * 而是监听渲染进程的 console 消息：注入脚本把调用打成带前缀的单行 JSON。
 */
class ChromeClient : public CefClient, public CefLifeSpanHandler, public CefDisplayHandler, public CefLoadHandler {
 public:
  explicit ChromeClient(TibWindow* window) : window_(window) {}

  // CefClient
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

  // CefDisplayHandler：捕获带前缀的 console 消息作为宿主调用
  bool OnConsoleMessage(CefRefPtr<CefBrowser> browser,
                        cef_log_severity_t level,
                        const CefString& message,
                        const CefString& source,
                        int line) override;
  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) override;

  // CefLoadHandler：加载状态变化 / 开始 / 完成 / 失败都要留证据
  void OnLoadingStateChange(CefRefPtr<CefBrowser> browser,
                            bool isLoading,
                            bool canGoBack,
                            bool canGoForward) override;
  void OnLoadStart(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   TransitionType transition_type) override;
  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int httpStatusCode) override;

  // CefLoadHandler：外壳页面加载失败时留下证据
  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode errorCode,
                   const CefString& errorText,
                   const CefString& failedUrl) override;

  // CefLifeSpanHandler
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;

  void SendEvent(const std::string& name, CefRefPtr<CefValue> payload);

 private:
  TibWindow* window_;
  CefRefPtr<CefBrowser> browser_;
  IMPLEMENT_REFCOUNTING(ChromeClient);
};

/** 网页标签页的客户端：导航拦截、标题/加载状态回传、安全扫描、右键菜单 */
class PageClient : public CefClient,
                   public CefLifeSpanHandler,
                   public CefLoadHandler,
                   public CefDisplayHandler,
                   public CefRequestHandler,
                   public CefContextMenuHandler {
 public:
  PageClient(TibWindow* window, std::string tab_id)
      : window_(window), tab_id_(std::move(tab_id)) {}

  // CefClient
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                               CefRefPtr<CefFrame> frame,
                               CefProcessId source_process,
                               CefRefPtr<CefProcessMessage> message) override;

  // CefLifeSpanHandler
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  bool OnBeforePopup(CefRefPtr<CefBrowser> browser,
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
                     bool* no_javascript_access) override;

  // CefLoadHandler
  void OnLoadingStateChange(CefRefPtr<CefBrowser> browser,
                            bool isLoading,
                            bool canGoBack,
                            bool canGoForward) override;
  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode errorCode,
                   const CefString& errorText,
                   const CefString& failedUrl) override;

  // CefDisplayHandler
  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) override;
  void OnAddressChange(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       const CefString& url) override;
  void OnFaviconURLChange(CefRefPtr<CefBrowser> browser,
                          const std::vector<CefString>& icon_urls) override;

  // CefRequestHandler
  bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                      CefRefPtr<CefFrame> frame,
                      CefRefPtr<CefRequest> request,
                      bool user_gesture,
                      bool is_redirect) override;

  // CefContextMenuHandler
  void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefFrame> frame,
                           CefRefPtr<CefContextMenuParams> params,
                           CefRefPtr<CefMenuModel> model) override;

  const std::string& tab_id() const { return tab_id_; }
  CefRefPtr<CefBrowser> browser() const { return browser_; }
  /** 标签页被关闭时调用，避免悬空指针 */
  void Detach() { window_ = nullptr; }

 private:
  TibWindow* window_;
  std::string tab_id_;
  CefRefPtr<CefBrowser> browser_;
  IMPLEMENT_REFCOUNTING(PageClient);
};

/**
 * 网页视图的委托。
 * 与 TibWindow 分开是必要的：TibWindow 作为委托时是「窗口级」的，
 * 而网页视图只需要浏览器视图这一层回调，并且必须声明 Alloy 运行时风格。
 */
class PageViewDelegate : public CefBrowserViewDelegate {
 public:
  PageViewDelegate(TibWindow* window, std::string tab_id)
      : window_(window), tab_id_(std::move(tab_id)) {}
  void OnBrowserCreated(CefRefPtr<CefBrowserView> browser_view,
                        CefRefPtr<CefBrowser> browser) override;
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

 private:
  TibWindow* window_;
  std::string tab_id_;
  IMPLEMENT_REFCOUNTING(PageViewDelegate);
};

/**
 * 外壳 UI 视图的委托。
 *
 * 为什么需要单独一个委托：CefBrowserView::CreateBrowserView 会在**内部同步**调用
 * OnBrowserCreated，那时 TibWindow::chrome_view_ 还没赋值，
 * 用 `browser_view == chrome_view_` 去认领回调必然失败（实测该回调因此从未触发）。
 * 由委托自己携带身份，就不依赖这种时序比较了。
 */
class ChromeViewDelegate : public CefBrowserViewDelegate {
 public:
  explicit ChromeViewDelegate(TibWindow* window) : window_(window) {}
  void OnBrowserCreated(CefRefPtr<CefBrowserView> browser_view,
                        CefRefPtr<CefBrowser> browser) override;
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

 private:
  TibWindow* window_;
  IMPLEMENT_REFCOUNTING(ChromeViewDelegate);
};

/**
 * 截图并把 PNG（base64）写到 path。成功返回 true。
 *
 * 这是"界面到底画出来没有"的权威证据：本机实测 PrintWindow 对 GPU 合成的
 * Chromium 窗口只能抓到白屏/桌面，而 CefBrowserHost::GetImage 直接向合成器取像素，
 * 且不要求窗口在前台。
 */

/** 一个浏览器窗口（无边框 CefWindow）：持有外壳 UI 与所有标签页 */
class TibWindow : public CefWindowDelegate, public CefBrowserViewDelegate {
 public:
  explicit TibWindow(bool incognito) : incognito_(incognito) {}

  // ---- 标签页操作（供 router 调用） ----
  std::string CreateTab(const std::string& input, bool activate);
  void CloseTab(const std::string& tab_id);
  void ActivateTab(const std::string& tab_id);
  void MoveTab(const std::string& tab_id, int index);
  void Navigate(const std::string& input);
  void GoBack();
  void GoForward();
  void Reload(bool ignore_cache);
  void Stop();
  void SetZoom(double level);
  void ToggleDevTools();
  void Close();

  // ---- 外壳布局（供路由调用） ----
  void SetOverlayOpen(bool open);
  void SetFindOpen(bool open);
  void ToggleSidebar(double width);
  void SetSidebarWidth(int width);
  // ---- 窗口控制 ----
  void Minimize();
  void Maximize();
  void Restore();

  CefRefPtr<CefBrowser> active_page() const;
  CefRefPtr<CefBrowser> chrome_browser() const;
  bool incognito() const { return incognito_; }

  /** 向 UI 推送事件（state / findResult / ...） */
  void SendEvent(const std::string& name, CefRefPtr<CefValue> payload);
  /** 推送完整标签状态 */
  void SyncState();
  /** 取当前全量状态 JSON（与 SyncState 推送的内容一致，供 state.get 使用） */
  std::string GetStateJson();
  /** 执行一段渲染进程 JS（用于投递回复与事件） */
  void RunInChrome(const std::string& js);
  /** 按当前 chrome 高度与侧栏宽度重新摆放网页视图 */
  void Layout();

  /** 由 PageClient 回调 */
  void OnTabTitle(const std::string& tab_id, const std::string& title);
  void OnTabUrl(const std::string& tab_id, const std::string& url);
  void OnTabLoading(const std::string& tab_id, bool loading, bool can_back, bool can_fwd);
  void OnTabFavicon(const std::string& tab_id, const std::string& url);
  void OnTabCreated(const std::string& tab_id, CefRefPtr<CefBrowser> browser,
                    CefRefPtr<PageClient> client);
  /** 由 PageViewDelegate 回调：网页视图已创建（执行挂起的首次导航） */
  void OnBrowserViewCreated(CefRefPtr<CefBrowserView> browser_view, CefRefPtr<CefBrowser> browser);
  /** 外壳 UI 视图就绪（由 ChromeViewDelegate 回调） */
  void OnChromeViewReady();
  /** 视图挂载完成后再加载外壳 UI（过早 LoadURL 会被丢弃） */
  void LoadChromeUi();
  /** 在渲染进程里跑一次外壳自检，结论回流到原生日志 */
  void RunUiSelfTest();
  /** 周期性采样外壳页面状态（times 次，每 interval_ms 毫秒一次），结论回流原生日志 */
  void StartUiDiagnostics(int times, int interval_ms);
  /** 窗口可见性兜底：居中 + 恢复 + 置前（CEF 首窗会落在最小化/屏幕外） */
  void EnsureVisibleOnScreen();
  /** 延迟调度一次可见性兜底 */
  void ScheduleActivationFallback();
  void OnTabClosed(const std::string& tab_id);
  /** 请求在新标签页打开（target=_blank / 中键） */
  bool OpenInNewTab(const std::string& url);

  // CefWindowDelegate
  void OnWindowCreated(CefRefPtr<CefWindow> window) override;
  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override;
  bool CanClose(CefRefPtr<CefWindow> window) override;
  void OnWindowBoundsChanged(CefRefPtr<CefWindow> window, const CefRect& new_bounds) override;
  /**
   * 必须显式给出初始位置与大小。
   * 不实现时 CEF 会把窗口放在 (-21333,-21333)（等于屏幕外），
   * 表现为「进程在跑、日志正常、但桌面上看不到窗口」。
   */
  CefRect GetInitialBounds(CefRefPtr<CefWindow> window) override;
  cef_show_state_t GetInitialShowState(CefRefPtr<CefWindow> window) override {
    return CEF_SHOW_STATE_NORMAL;
  }
  bool IsFrameless(CefRefPtr<CefWindow> window) override { return true; }
  bool WithStandardWindowButtons(CefRefPtr<CefWindow> window) override { return false; }
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

  // CefBrowserViewDelegate
  void OnBrowserCreated(CefRefPtr<CefBrowserView> browser_view,
                        CefRefPtr<CefBrowser> browser) override;
  /**
   * 必须显式声明 Alloy 运行时风格。
   * 默认值 CEF_RUNTIME_STYLE_DEFAULT 会被当成 Chrome 风格，而 Chrome 风格的
   * BrowserView 不允许挂到 Alloy 风格的 Window 上（CEF 会打印
   * "Cannot add Chrome style BrowserView to Alloy style Window" 并直接忽略该视图，
   * 表现为窗口空白、页面不加载）。
   */
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

 private:
  struct Tab;

  bool incognito_ = false;
  bool chrome_view_ready_ = false;
  CefRefPtr<CefWindow> window_;
  CefRefPtr<ChromeClient> chrome_client_;
  CefRefPtr<CefBrowserView> chrome_view_;
  CefRefPtr<CefBrowserView> content_view_;
  std::vector<std::shared_ptr<Tab>> tabs_;
  std::string active_id_;
  int chrome_height_ = kChromeHeight;
  int sidebar_width_ = 0;
  bool overlay_open_ = false;
  bool find_open_ = false;

  friend class ChromeClient;
  IMPLEMENT_REFCOUNTING(TibWindow);
};

/** 创建主窗口（incognito=true 时为无痕窗口 2.0） */
void CreateMainWindow(bool incognito);

/** 全局：关闭所有窗口 */
void CloseAllWindows();

}  // namespace tib
