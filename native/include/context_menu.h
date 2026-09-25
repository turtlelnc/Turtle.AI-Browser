// 网页右键菜单：Chrome/Edge 级右键能力
//
// 为什么自己做而不是用 CEF 的默认菜单：
//   * CEF 的默认菜单只有「后退 / 前进 / 打印 / 查看源代码 / 重新加载」几项，
//     既没有标签页相关动作，也没有缩放、另存为、复制链接等日常操作；
//   * 本窗口是无边框窗口（标题栏与菜单栏都是自绘的 React UI），
//     而网页视图是独立的 CEF BrowserView，网页里的右键事件到不了外壳 UI，
//     因此右键菜单必须由原生侧弹出（外壳 UI 只负责自己那一块区域）。
//
// 设计要点：把「上下文事实」与 CEF 的 CefContextMenuParams 解耦成 PageMenuFacts，
// 于是菜单构造逻辑可以脱离真实网页被自检（--tib-menu-probe）——
// 否则"右键菜单到底有几项、哪些可用"只能靠人手点一下才知道。
#pragma once

#include "tib_common.h"

#include "include/cef_context_menu_handler.h"
#include "include/cef_menu_model.h"
#include "include/cef_menu_model_delegate.h"

namespace tib {

class TibWindow;

/** 构造菜单需要的上下文事实（真实路径由 CefContextMenuParams 填充，自检路径由代码填充） */
struct PageMenuFacts {
  bool can_go_back = false;
  bool can_go_forward = false;
  bool is_loading = false;
  bool has_link = false;
  std::string link_url;
  bool has_image = false;
  std::string image_url;
  bool editable = false;
  bool can_undo = false;
  bool can_redo = false;
  bool can_cut = false;
  bool can_copy = false;
  bool can_paste = false;
  bool can_delete = false;
  bool can_select_all = false;
  std::string selection_text;
  std::string page_url;
  double zoom = 0.0;
};

/** 菜单命令 id：从 2001 起，避开 CEF 保留的 1..N（默认菜单命令） */
enum PageMenuId {
  kMenuBack = 2001,
  kMenuForward,
  kMenuReload,
  kMenuStop,
  kMenuOpenLinkNewTab,
  kMenuCopyLink,
  kMenuSaveLink,
  kMenuOpenImageNewTab,
  kMenuCopyImageUrl,
  kMenuSaveImage,
  kMenuUndo,
  kMenuRedo,
  kMenuCut,
  kMenuCopy,
  kMenuPaste,
  kMenuDelete,
  kMenuSelectAll,
  kMenuSearchSelection,
  kMenuZoomIn,
  kMenuZoomOut,
  kMenuZoomReset,
  kMenuPrintPdf,
  kMenuViewSource,
  kMenuInspect,
};

/**
 * 按上下文事实填充菜单模型。
 * 返回菜单内容的中文可读描述（形如「返回 | 前进 | 重新加载 | --- | 复制链接地址」），
 * 用于日志与自检 —— 菜单是否"该有的都有、该禁用的禁用了"就以这段文字为证据。
 */
std::string FillPageMenu(CefRefPtr<CefMenuModel> model, const PageMenuFacts& facts);

/** 执行菜单命令（所有动作都走 TibWindow 的公开能力，便于单独验证） */
void RunPageMenuCommand(CefRefPtr<TibWindow> window,
                        CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        const PageMenuFacts& facts,
                        int command_id);

/** 由 PageClient 调用：把 CEF 的右键上下文转成事实、构造菜单并弹出 */
void ShowPageContextMenu(CefRefPtr<TibWindow> window,
                         CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefFrame> frame,
                         CefRefPtr<CefContextMenuParams> params);

/**
 * 右键菜单自检（--tib-menu-probe[=show]）。
 * 用一份"链接 + 图片 + 可编辑 + 有选区"的合成上下文构造菜单并打印内容；
 * show=true 时真实弹出，并在 1.5 秒后自动收起 —— 用来证明
 * 「菜单能构造」之外「菜单能显示」，而这两件事都可能各自坏掉。
 */
void RunContextMenuSelfTest(CefRefPtr<TibWindow> window, bool show);

/** 延迟 3 秒后执行上面的自检（窗口刚创建时视图还没布局完，必须等一会） */
void ScheduleContextMenuSelfTest(CefRefPtr<TibWindow> window, bool show);

}  // namespace tib
