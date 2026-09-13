// 浏览器窗口：多标签模型 + Views 布局（外壳 UI 在上，网页视图在下）
#pragma once

#include "tib_common.h"

namespace tib {

class TibWindow;

/** 外壳 UI 浏览器（tib://ui）的客户端：只挂消息路由，不做导航拦截 */
class ChromeClient : public CefClient, public CefLifeSpanHandler {
 public:
  explicit ChromeClient(TibWindow* window) : window_(window) {}

  CefRefPtr<CefMessageRouterBrowserSide> router() const { return router_; }
  void set_router(CefRefPtr<CefMessageRouterBrowserSide> router) { router_ = router; }

  // CefClient
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                               CefRefPtr<CefFrame> frame,
                               CefProcessId source_process,
                               CefRefPtr<CefProcessMessage> message) override;

  // CefLifeSpanHandler
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;

  void SendEvent(const std::string& name, CefRefPtr<CefValue> payload);

 private:
  TibWindow* window_;
  CefRefPtr<CefMessageRouterBrowserSide> router_;
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

  CefRefPtr<CefBrowser> active_page() const;
  CefRefPtr<CefBrowser> chrome_browser() const;
  bool incognito() const { return incognito_; }

  /** 向 UI 推送事件（state / findResult / ...） */
  void SendEvent(const std::string& name, CefRefPtr<CefValue> payload);
  /** 推送完整标签状态 */
  void SyncState();
  /** 按当前 chrome 高度与侧栏宽度重新摆放网页视图 */
  void Layout();

  /** 由 PageClient 回调 */
  void OnTabTitle(const std::string& tab_id, const std::string& title);
  void OnTabUrl(const std::string& tab_id, const std::string& url);
  void OnTabLoading(const std::string& tab_id, bool loading, bool can_back, bool can_fwd);
  void OnTabFavicon(const std::string& tab_id, const std::string& url);
  void OnTabCreated(const std::string& tab_id, CefRefPtr<CefBrowser> browser,
                    CefRefPtr<PageClient> client);
  void OnTabClosed(const std::string& tab_id);
  /** 请求在新标签页打开（target=_blank / 中键） */
  bool OpenInNewTab(const std::string& url);

  // CefWindowDelegate
  void OnWindowCreated(CefRefPtr<CefWindow> window) override;
  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override;
  bool CanClose(CefRefPtr<CefWindow> window) override;
  void OnWindowBoundsChanged(CefRefPtr<CefWindow> window,
                            const CefRect& new_bounds,
                            const CefRect& old_bounds) override;
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

  // CefBrowserViewDelegate
  bool OnBrowserViewIsLoading(CefRefPtr<CefBrowserView> browser_view,
                              CefRefPtr<CefBrowser> browser,
                              CefRefPtr<CefFrame> frame,
                              int identifier) override {
    return false;
  }
  void OnBrowserCreated(CefRefPtr<CefBrowserView> browser_view,
                        CefRefPtr<CefBrowser> browser) override;

 private:
  struct Tab;

  CefRefPtr<CefMessageRouterBrowserSide> EnsureRouter();

  bool incognito_ = false;
  CefRefPtr<CefWindow> window_;
  CefRefPtr<ChromeClient> chrome_client_;
  CefRefPtr<CefBrowserView> chrome_view_;
  CefRefPtr<CefBrowserView> content_view_;
  CefRefPtr<CefMessageRouterBrowserSide> router_;
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
