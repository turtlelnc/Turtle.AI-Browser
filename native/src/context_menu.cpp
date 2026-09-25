// 网页右键菜单实现（条目组织、命令执行、自检）
#include "context_menu.h"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <ctime>
#include <fstream>
#include <vector>

#include "security.h"
#include "store.h"
#include "window.h"

namespace tib {
namespace {

/** 标签过长会撑坏菜单宽度，截断后加省略号 */
std::string Shorten(const std::string& text, size_t max_len) {
  if (text.size() <= max_len) return text;
  // 按字节截断可能切到 UTF-8 中间；退到最后一个完整字符边界
  size_t cut = max_len;
  while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80) --cut;
  return text.substr(0, cut) + "…";
}

/** 把标题之类的内容变成合法文件名（Windows 上 : / \ | ? * 等都不能出现在文件名里） */
std::string SanitizeFileName(const std::string& in) {
  std::string out;
  for (unsigned char ch : in) {
    const bool bad = ch < 0x20 || ch == '<' || ch == '>' || ch == ':' || ch == '"' || ch == '/' ||
                     ch == '\\' || ch == '|' || ch == '?' || ch == '*';
    out.push_back(bad ? '_' : static_cast<char>(ch));
  }
  while (!out.empty() && (out.back() == ' ' || out.back() == '.')) out.pop_back();
  if (out.size() > 80) out = out.substr(0, 80);
  return out;
}

/** 打印为 PDF / 另存为用的默认目录：数据目录下的 Downloads */
std::string DownloadsDir() {
  const std::string dir = AppContext::Get().user_data_dir() + "\\Downloads";
  ::CreateDirectoryA(dir.c_str(), nullptr);
  return dir;
}

/** 取 URL 路径部分的文件名（去掉查询串），失败时给一个兜底名 */
std::string FileNameFromUrl(const std::string& url, const std::string& fallback) {
  CefURLParts parts;
  std::string path = url;
  if (CefParseURL(url, parts)) path = CefString(&parts.path).ToString();
  const size_t slash = path.find_last_of("/\\");
  std::string name = slash == std::string::npos ? path : path.substr(slash + 1);
  const size_t query = name.find('?');
  if (query != std::string::npos) name = name.substr(0, query);
  name = SanitizeFileName(name);
  if (name.empty()) name = fallback;
  return name;
}

/** 同名文件已存在时追加 (1) (2)…，避免"另存为"静默覆盖用户已有的文件 */
std::string UniquePath(const std::string& dir, const std::string& name) {
  const std::string full = dir + "\\" + name;
  if (::GetFileAttributesA(full.c_str()) == INVALID_FILE_ATTRIBUTES) return full;

  std::string stem = name;
  std::string ext;
  const size_t dot = name.find_last_of('.');
  if (dot != std::string::npos && dot > 0) {
    stem = name.substr(0, dot);
    ext = name.substr(dot);
  }
  for (int i = 1; i < 1000; ++i) {
    const std::string candidate =
        dir + "\\" + stem + " (" + std::to_string(i) + ")" + ext;
    if (::GetFileAttributesA(candidate.c_str()) == INVALID_FILE_ATTRIBUTES) return candidate;
  }
  return full;
}

/** 记一条下载到本地列表（菜单发起的保存动作与网页下载共用同一份记录） */
void RecordSavedFile(const std::string& url,
                     const std::string& name,
                     const std::string& path,
                     int64_t bytes,
                     const std::string& state) {
  DownloadRecord record;
  record.id = MakeId();
  record.filename = name;
  record.url = url;
  record.save_path = path;
  record.received = bytes;
  record.total = bytes;
  record.state = state;
  record.started_at = static_cast<int64_t>(::time(nullptr));
  NativeStore::Get().UpsertDownload(record);
}

/** 图片另存为的回调：把 CefImage 以 PNG 落盘，并记进下载列表 */
class SaveImageCallback : public CefDownloadImageCallback {
 public:
  SaveImageCallback(std::string dir, std::string name, std::string url)
      : dir_(std::move(dir)), name_(std::move(name)), url_(std::move(url)) {}

  void OnDownloadImageFinished(const CefString& image_url,
                               int http_status_code,
                               CefRefPtr<CefImage> image) override {
    const std::string url = image_url.ToString();
    if (!image || image->IsEmpty()) {
      Log("图片另存为失败：未能取到图片数据（HTTP " + std::to_string(http_status_code) + "）" + url);
      return;
    }
    int width = 0;
    int height = 0;
    CefRefPtr<CefBinaryValue> png = image->GetAsPNG(1.0f, true, width, height);
    if (!png || png->GetSize() == 0) {
      Log("图片另存为失败：PNG 编码为空 " + url);
      return;
    }
    const std::string path = UniquePath(dir_, name_);
    std::vector<unsigned char> buffer(png->GetSize());
    png->GetData(buffer.data(), buffer.size(), 0);
    {
      std::ofstream out(path, std::ios::binary | std::ios::trunc);
      if (!out) {
        Log("图片另存为失败：无法写入 " + path);
        return;
      }
      out.write(reinterpret_cast<const char*>(buffer.data()),
                static_cast<std::streamsize>(buffer.size()));
    }
    Log("图片已另存为 " + path + "（" + std::to_string(width) + "x" + std::to_string(height) +
        "，" + std::to_string(buffer.size()) + " 字节）");
    RecordSavedFile(url, name_, path, static_cast<int64_t>(buffer.size()), "completed");
  }

 private:
  std::string dir_;
  std::string name_;
  std::string url_;
  IMPLEMENT_REFCOUNTING(SaveImageCallback);
};

/** 打印为 PDF 的回调：成败都如实写日志 */
class PdfPrintCallback : public CefPdfPrintCallback {
 public:
  explicit PdfPrintCallback(std::string path) : path_(std::move(path)) {}
  void OnPdfPrintFinished(const CefString& path, bool ok) override {
    Log(std::string("打印为 PDF ") + (ok ? "完成：" : "失败：") + path.ToString());
    if (!ok) Log("提示：打印为 PDF 失败时页面可能尚未加载完成，或该页面禁止打印");
  }

 private:
  std::string path_;
  IMPLEMENT_REFCOUNTING(PdfPrintCallback);
};

/** 菜单命令的执行者：菜单模型把命令回调到这里 */
class PageMenuDelegate : public CefMenuModelDelegate {
 public:
  PageMenuDelegate(CefRefPtr<TibWindow> window,
                   CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   PageMenuFacts facts)
      : window_(std::move(window)),
        browser_(std::move(browser)),
        frame_(std::move(frame)),
        facts_(std::move(facts)) {}

  void ExecuteCommand(CefRefPtr<CefMenuModel> model,
                      int command_id,
                      cef_event_flags_t event_flags) override {
    (void)model;
    (void)event_flags;
    RunPageMenuCommand(window_, browser_, frame_, facts_, command_id);
  }

  void MenuClosed(CefRefPtr<CefMenuModel> menu_model) override {
    (void)menu_model;
    Log("页面右键菜单：已收起");
  }

 private:
  // 必须用 CefRefPtr 持有窗口：菜单弹出期间窗口可能被关闭，
  // 裸指针在菜单收起时就会变成悬空指针（这个坑在延迟任务上踩过一次，见 UiProbeTask）。
  CefRefPtr<TibWindow> window_;
  CefRefPtr<CefBrowser> browser_;
  CefRefPtr<CefFrame> frame_;
  PageMenuFacts facts_;
  IMPLEMENT_REFCOUNTING(PageMenuDelegate);
};

/** 自检用：把已经弹出的菜单收起来（ShowMenu 是阻塞调用，只能靠延迟任务收） */
class CancelMenuTask : public CefTask {
 public:
  explicit CancelMenuTask(CefRefPtr<TibWindow> window) : window_(std::move(window)) {}
  void Execute() override {
    CefRefPtr<CefWindow> cef_window = window_ ? window_->cef_window() : nullptr;
    if (!cef_window) return;
    // 实测（2026-09-18，--tib-menu-probe=show）：这个延迟任务**不会**在菜单的嵌套消息循环
    // 里被派发 —— 日志顺序是"真实弹出 → ShowMenu 已返回 → （1.5 秒后）本行"，
    // 菜单实际是被别的因素收起的（本机上约 3 秒后自行收起，与是否有前台焦点有关）。
    // 因此这里保留为兜底，并如实说明它可能是一次空操作，不能拿它当"自动收起已验证"。
    Log("右键菜单自检：延迟收起任务执行（若菜单已由其它方式收起，这里是空操作）");
    cef_window->CancelMenu();
  }

 private:
  CefRefPtr<TibWindow> window_;
  IMPLEMENT_REFCOUNTING(CancelMenuTask);
};

/** 延迟执行右键菜单自检（窗口刚创建时视图还没布局好，必须等一会） */
class MenuProbeTask : public CefTask {
 public:
  MenuProbeTask(CefRefPtr<TibWindow> window, bool show)
      : window_(std::move(window)), show_(show) {}
  void Execute() override {
    if (!window_) return;
    RunContextMenuSelfTest(window_, show_);
  }

 private:
  CefRefPtr<TibWindow> window_;
  bool show_;
  IMPLEMENT_REFCOUNTING(MenuProbeTask);
};

/** 自检用的合成上下文：一次覆盖链接、图片、可编辑、有选区四类条目 */
PageMenuFacts SampleFacts() {
  PageMenuFacts f;
  f.can_go_back = true;
  f.can_go_forward = true;
  f.is_loading = false;
  f.has_link = true;
  f.link_url = "https://example.com/download/setup.exe";
  f.has_image = true;
  f.image_url = "https://example.com/images/logo.png";
  f.editable = true;
  f.can_undo = true;
  f.can_redo = false;
  f.can_cut = true;
  f.can_copy = true;
  f.can_paste = true;
  f.can_delete = true;
  f.can_select_all = true;
  f.selection_text = "选中的一段文字";
  f.page_url = "https://example.com/page";
  f.zoom = 0.0;
  return f;
}

/** 菜单项数量（不含分隔线；分隔线的命令 id 不是正数） */
int ItemCount(CefRefPtr<CefMenuModel> model) {
  if (!model) return 0;
  int count = 0;
  for (size_t i = 0; i < model->GetCount(); ++i) {
    if (model->GetCommandIdAt(i) > 0) count++;
  }
  return count;
}

}  // namespace

std::string FillPageMenu(CefRefPtr<CefMenuModel> model, const PageMenuFacts& facts) {
  if (!model) return "";
  model->Clear();

  std::string desc;
  auto append_desc = [&](const std::string& text) {
    if (!desc.empty()) desc += " | ";
    desc += text;
  };
  auto item = [&](int id, const std::string& label, bool enabled) {
    model->AddItem(id, label);
    model->SetEnabled(id, enabled);
    append_desc(label + (enabled ? "" : "(禁用)"));
  };
  auto separator = [&]() {
    model->AddSeparator();
    append_desc("---");
  };

  // ---- 导航 ----
  item(kMenuBack, "返回", facts.can_go_back);
  item(kMenuForward, "前进", facts.can_go_forward);
  if (facts.is_loading) {
    item(kMenuStop, "停止加载", true);
  } else {
    item(kMenuReload, "重新加载", true);
  }
  model->SetAccelerator(kMenuBack, VK_LEFT, false, false, true);
  model->SetAccelerator(kMenuForward, VK_RIGHT, false, false, true);
  model->SetAccelerator(kMenuReload, 'R', false, true, false);

  // ---- 链接 ----
  if (facts.has_link) {
    separator();
    item(kMenuOpenLinkNewTab, "在新标签页中打开链接", true);
    item(kMenuCopyLink, "复制链接地址", true);
    item(kMenuSaveLink, "链接另存为…", true);
  }

  // ---- 图片 ----
  if (facts.has_image) {
    separator();
    item(kMenuOpenImageNewTab, "在新标签页中打开图片", true);
    item(kMenuCopyImageUrl, "复制图片地址", true);
    item(kMenuSaveImage, "图片另存为…", true);
  }

  // ---- 编辑 / 选区 ----
  const bool any_edit = facts.editable || facts.can_copy || !facts.selection_text.empty();
  if (any_edit) {
    separator();
    if (facts.editable) {
      item(kMenuUndo, "撤销", facts.can_undo);
      item(kMenuRedo, "重做", facts.can_redo);
      item(kMenuCut, "剪切", facts.can_cut);
    }
    item(kMenuCopy, "复制", facts.can_copy || !facts.selection_text.empty());
    if (facts.editable) {
      item(kMenuPaste, "粘贴", facts.can_paste);
      item(kMenuDelete, "删除", facts.can_delete);
    }
    item(kMenuSelectAll, "全选", facts.can_select_all || facts.editable);
    if (!facts.selection_text.empty() && !facts.editable) {
      item(kMenuSearchSelection, "搜索「" + Shorten(facts.selection_text, 20) + "」", true);
    }
  }

  // ---- 缩放 ----
  separator();
  item(kMenuZoomIn, "放大", true);
  item(kMenuZoomOut, "缩小", true);
  item(kMenuZoomReset, "重置为 100%", facts.zoom != 0.0);
  model->SetAccelerator(kMenuZoomIn, VK_OEM_PLUS, false, true, false);
  model->SetAccelerator(kMenuZoomOut, VK_OEM_MINUS, false, true, false);
  model->SetAccelerator(kMenuZoomReset, '0', false, true, false);

  // ---- 页面级动作 ----
  separator();
  item(kMenuPrintPdf, "打印为 PDF…", true);
  item(kMenuViewSource, "查看页面源代码", true);
  item(kMenuInspect, "检查元素", true);
  model->SetAccelerator(kMenuViewSource, 'U', false, true, false);

  return desc;
}

void RunPageMenuCommand(CefRefPtr<TibWindow> window,
                        CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        const PageMenuFacts& facts,
                        int command_id) {
  if (!window) return;
  const AppSettings& settings = NativeStore::Get().settings;

  switch (command_id) {
    case kMenuBack:
      window->GoBack();
      break;
    case kMenuForward:
      window->GoForward();
      break;
    case kMenuReload:
      window->Reload(false);
      break;
    case kMenuStop:
      window->Stop();
      break;

    case kMenuOpenLinkNewTab:
      if (!facts.link_url.empty()) window->CreateTab(facts.link_url, true);
      break;
    case kMenuCopyLink:
      if (SetClipboardText(facts.link_url)) Log("已复制链接地址：" + facts.link_url);
      else Log("复制链接地址失败：无法访问剪贴板");
      break;
    case kMenuSaveLink:
      if (browser && browser->GetHost() && !facts.link_url.empty()) {
        // 走内核自己的下载管线：进度、落盘路径与安全判定都由 CefDownloadHandler 处理，
        // 这里不自己拼 HTTP 请求，避免"另存为"与"下载"出现两套不一致的行为。
        Log("链接另存为：交给下载管线 " + facts.link_url);
        browser->GetHost()->StartDownload(facts.link_url);
      }
      break;

    case kMenuOpenImageNewTab:
      if (!facts.image_url.empty()) window->CreateTab(facts.image_url, true);
      break;
    case kMenuCopyImageUrl:
      if (SetClipboardText(facts.image_url)) Log("已复制图片地址：" + facts.image_url);
      else Log("复制图片地址失败：无法访问剪贴板");
      break;
    case kMenuSaveImage:
      if (browser && browser->GetHost() && !facts.image_url.empty()) {
        const std::string name = FileNameFromUrl(facts.image_url, "image.png");
        Log("图片另存为：" + facts.image_url + " → " + name);
        browser->GetHost()->DownloadImage(
            facts.image_url, false, 0, false,
            new SaveImageCallback(DownloadsDir(), name, facts.image_url));
      }
      break;

    case kMenuUndo:
      if (frame) frame->Undo();
      break;
    case kMenuRedo:
      if (frame) frame->Redo();
      break;
    case kMenuCut:
      if (frame) frame->Cut();
      break;
    case kMenuCopy:
      if (frame) frame->Copy();
      break;
    case kMenuPaste:
      if (frame) frame->Paste();
      break;
    case kMenuDelete:
      if (frame) frame->Delete();
      break;
    case kMenuSelectAll:
      if (frame) frame->SelectAll();
      break;
    case kMenuSearchSelection:
      if (!facts.selection_text.empty()) {
        window->CreateTab(ResolveNavigationInput(facts.selection_text, settings.search_engine), true);
      }
      break;

    case kMenuZoomIn:
      if (browser) window->SetZoom(browser->GetHost()->GetZoomLevel() + 0.5);
      break;
    case kMenuZoomOut:
      if (browser) window->SetZoom(browser->GetHost()->GetZoomLevel() - 0.5);
      break;
    case kMenuZoomReset:
      window->SetZoom(0.0);
      break;

    case kMenuPrintPdf: {
      if (!browser || !browser->GetHost()) break;
      std::string name = SanitizeFileName(window->GetActiveTitle());
      if (name.empty()) name = FileNameFromUrl(window->GetActiveUrl(), "page");
      const std::string path = UniquePath(DownloadsDir(), name + ".pdf");
      Log("打印为 PDF：" + path);
      CefPdfPrintSettings print_settings;
      print_settings.print_background = true;
      print_settings.display_header_footer = false;
      browser->GetHost()->PrintToPDF(path, print_settings, new PdfPrintCallback(path));
      break;
    }
    case kMenuViewSource:
      if (frame) frame->ViewSource();
      break;
    case kMenuInspect:
      window->ToggleDevTools();
      break;

    default:
      Log("页面右键菜单：收到未处理的命令 " + std::to_string(command_id));
      break;
  }
}

void ShowPageContextMenu(CefRefPtr<TibWindow> window,
                         CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefFrame> frame,
                         CefRefPtr<CefContextMenuParams> params) {
  if (!window || !browser || !params) return;
  CefRefPtr<CefWindow> cef_window = window->cef_window();
  if (!cef_window) {
    Log("页面右键菜单：窗口尚未就绪，忽略本次右键");
    return;
  }

  PageMenuFacts facts;
  facts.has_link = (params->GetTypeFlags() & CM_TYPEFLAG_LINK) != 0;
  facts.link_url = params->GetLinkUrl().ToString();
  facts.has_image = params->GetMediaType() == CM_MEDIATYPE_IMAGE;
  facts.image_url = facts.has_image ? params->GetSourceUrl().ToString() : std::string();
  facts.editable = params->IsEditable();
  facts.selection_text = params->GetSelectionText().ToString();
  facts.page_url = params->GetPageUrl().ToString();
  const int edit_flags = params->GetEditStateFlags();
  facts.can_undo = (edit_flags & CM_EDITFLAG_CAN_UNDO) != 0;
  facts.can_redo = (edit_flags & CM_EDITFLAG_CAN_REDO) != 0;
  facts.can_cut = (edit_flags & CM_EDITFLAG_CAN_CUT) != 0;
  facts.can_copy = (edit_flags & CM_EDITFLAG_CAN_COPY) != 0;
  facts.can_paste = (edit_flags & CM_EDITFLAG_CAN_PASTE) != 0;
  facts.can_delete = (edit_flags & CM_EDITFLAG_CAN_DELETE) != 0;
  facts.can_select_all = (edit_flags & CM_EDITFLAG_CAN_SELECT_ALL) != 0;
  facts.zoom = browser->GetHost()->GetZoomLevel();
  // 有选区但内核没给"可复制"标志时（例如选中普通文本），按有选区处理
  if (!facts.selection_text.empty()) facts.can_copy = true;

  // 坐标换算：params 给的是视图内坐标，ShowMenu 要的是屏幕坐标。
  CefPoint point(params->GetXCoord(), params->GetYCoord());
  if (CefRefPtr<CefBrowserView> view = CefBrowserView::GetForBrowser(browser)) {
    view->ConvertPointToScreen(point);
  }

  CefRefPtr<PageMenuDelegate> delegate = new PageMenuDelegate(window, browser, frame, facts);
  CefRefPtr<CefMenuModel> model = CefMenuModel::CreateMenuModel(delegate);
  const std::string desc = FillPageMenu(model, facts);
  Log("页面右键菜单：弹出（" + std::to_string(ItemCount(model)) + " 项）" + desc);
  // 注意：ShowMenu 会跑一个嵌套消息循环，直到菜单被选中/收起才返回 ——
  // 这也是它必须由用户在真实右键动作里触发的原因，不能放在任何启动路径上。
  cef_window->ShowMenu(model, point, CEF_MENU_ANCHOR_TOPLEFT);
  Log("页面右键菜单：ShowMenu 已返回");
}

void RunContextMenuSelfTest(CefRefPtr<TibWindow> window, bool show) {
  const PageMenuFacts facts = SampleFacts();
  CefRefPtr<PageMenuDelegate> delegate =
      new PageMenuDelegate(window, window ? window->active_page() : nullptr, nullptr, facts);
  CefRefPtr<CefMenuModel> model = CefMenuModel::CreateMenuModel(delegate);
  const std::string desc = FillPageMenu(model, facts);
  Log("右键菜单自检：合成上下文（链接+图片+可编辑+有选区）构造出 " +
      std::to_string(ItemCount(model)) + " 项");
  Log("右键菜单自检：内容 " + desc);

  // 核对"该禁用的确实禁用了"：返回可用、重做与重置缩放禁用。
  // 若状态不对，说明可用性判断根本没接上（菜单里会出现一堆点了没反应的项）。
  //
  // 注意 CefMenuModel 有两个容易混的接口：
  //   IsEnabled(int command_id)  —— 按命令 id 查
  //   IsEnabledAt(size_t index)  —— 按菜单项下标查
  // 第一版自检把下标传给了前者，于是"内容明明对、判定却报异常"。
  const int back_index = model->GetIndexOf(kMenuBack);
  const int redo_index = model->GetIndexOf(kMenuRedo);
  const int zoom_index = model->GetIndexOf(kMenuZoomReset);
  const bool back_enabled = back_index >= 0 && model->IsEnabledAt(static_cast<size_t>(back_index));
  const bool redo_disabled = redo_index >= 0 && !model->IsEnabledAt(static_cast<size_t>(redo_index));
  const bool zoom_disabled = zoom_index >= 0 && !model->IsEnabledAt(static_cast<size_t>(zoom_index));

  // 把菜单模型自身的状态打出来：上面的描述串来自构造参数，
  // 只有这一行是"模型自己怎么认"，两者一致才说明菜单真的按上下文设置好了。
  std::string model_state;
  for (size_t i = 0; i < model->GetCount(); ++i) {
    if (model->GetCommandIdAt(i) <= 0) continue;
    model_state += model->GetLabelAt(i).ToString() + "=" +
                   (model->IsEnabledAt(i) ? "启用" : "禁用") + " ";
  }
  Log("右键菜单自检：模型自身状态 " + model_state);

  Log(std::string("右键菜单自检：可用性判断 ") +
      ((back_enabled && redo_disabled && zoom_disabled)
           ? "正确（返回可用、重做与重置缩放禁用）"
           : "异常（可用性未按上下文设置）"));

  if (!show) return;

  CefRefPtr<CefWindow> cef_window = window ? window->cef_window() : nullptr;
  if (!cef_window) {
    Log("右键菜单自检：窗口尚未就绪，跳过真实弹出");
    return;
  }
  // ShowMenu 会阻塞到菜单收起（真实浏览器也是这个语义：菜单期间 UI 线程跑嵌套循环），
  // 因此先安排一个延迟收起作为兜底，再弹出。
  // 实测：这个延迟任务不会在嵌套循环里派发（见 CancelMenuTask 的说明），
  // 自检只保证"菜单能弹出来、不崩、进程继续活着"，收起仍由菜单自身完成。
  CefPostDelayedTask(TID_UI, new CancelMenuTask(window), 1500);
  Log("右键菜单自检：真实弹出（延迟收起任务已排入队列）");
  cef_window->ShowMenu(model, CefPoint(320, 240), CEF_MENU_ANCHOR_TOPLEFT);
  Log("右键菜单自检：ShowMenu 已返回（菜单已收起）");
  Log("右键菜单自检：完成");
}

void ScheduleContextMenuSelfTest(CefRefPtr<TibWindow> window, bool show) {
  CefPostDelayedTask(TID_UI, new MenuProbeTask(window, show), 3000);
}

}  // namespace tib
