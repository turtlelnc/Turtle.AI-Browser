// tib:// 协议实现
#include "scheme.h"

#include "router.h"

#include <algorithm>

namespace tib {
namespace {

/** 极简 mime 推断：外壳页面只用到这几种 */
std::string MimeForPath(const std::string& path) {
  auto ends = [&](const char* suffix) {
    const size_t n = strlen(suffix);
    return path.size() >= n && path.compare(path.size() - n, n, suffix) == 0;
  };
  if (ends(".html")) return "text/html";
  if (ends(".js") || ends(".mjs")) return "text/javascript";
  if (ends(".css")) return "text/css";
  if (ends(".json")) return "application/json";
  if (ends(".svg")) return "image/svg+xml";
  if (ends(".png")) return "image/png";
  if (ends(".jpg") || ends(".jpeg")) return "image/jpeg";
  if (ends(".webp")) return "image/webp";
  if (ends(".woff2")) return "font/woff2";
  if (ends(".woff")) return "font/woff";
  if (ends(".txt")) return "text/plain";
  return "application/octet-stream";
}

/** 把 URL 路径里的百分号编码还原成 UTF-8 字节 */
std::string PercentDecode(const std::string& in) {
  std::string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size(); ++i) {
    if (in[i] == '%' && i + 2 < in.size()) {
      auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      const int hi = hex(in[i + 1]);
      const int lo = hex(in[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>(hi * 16 + lo));
        i += 2;
        continue;
      }
    }
    out.push_back(in[i]);
  }
  return out;
}

/**
 * 创建 __tibHost 的小垫片：把调用转成 CEF 消息路由的查询。
 * 与 tib-host.js 分开是因为前者是「传输」，后者是「协议与 API」。
 */
std::string HostTransportScript() {
  return R"JS(
(function () {
  window.__tibHost = {
    call: function (id, method, params) {
      if (typeof window.tibPreload !== 'function') {
        console.error('[TiBrowser] 原生消息路由不可用（tibPreload 未注入）');
        if (window.__tibDeliverReply) {
          window.__tibDeliverReply(id, false, null, '原生消息路由不可用');
        }
        return;
      }
      window.tibPreload({
        request: JSON.stringify({ id: id, method: method, params: params || {} }),
        persistent: false,
        onFailure: function (code, message) {
          if (window.__tibDeliverReply) {
            window.__tibDeliverReply(id, false, null, message || ('原生调用失败（' + code + '）'));
          }
        }
      });
    }
  };
})();
)JS";
}

/** 取引导数据（皮肤 / 主题 / 性能档），供首屏防闪烁 */
std::string BootDataScript() {
  const AppContext& ctx = AppContext::Get();
  return "<script>window.__TIB_BOOT__={skin:'" + ctx.skin() +
         "',theme:'system',perf:'high'};</script>";
}

/**
 * 把宿主脚本内联进 index.html。
 * 必须在 UI 自身的 module 脚本之前执行，否则 React 首次渲染时拿不到 window.tib，
 * 会退化到 mock 桥并提示"未检测到原生宿主"。
 */
std::string InjectHostBridge(const std::string& html) {
  const std::string script =
      "<script>" + HostTransportScript() + "</script>" + "<script>" + HostBridgeScript() +
      "</script>" + BootDataScript();
  const std::string marker = "<head>";
  const size_t pos = html.find(marker);
  if (pos == std::string::npos) return script + html;
  return html.substr(0, pos + marker.size()) + "\n" + script + html.substr(pos + marker.size());
}

/** 资源处理器：从内存缓冲区回给渲染进程 */
class BufferResourceHandler : public CefResourceHandler {
 public:
  BufferResourceHandler(std::string mime, std::string body)
      : mime_(std::move(mime)), body_(std::move(body)) {}

  bool Open(CefRefPtr<CefRequest> request,
            bool& handle_request,
            CefRefPtr<CefCallback> callback) override {
    handle_request = true;
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response,
                          int64_t& response_length,
                          CefString& redirect_url) override {
    response->SetStatus(200);
    response->SetMimeType(mime_);
    response->SetHeaderByName("Cache-Control", "no-cache", true);
    response_length = static_cast<int64_t>(body_.size());
  }

  bool Read(void* data_out,
            int bytes_to_read,
            int& bytes_read,
            CefRefPtr<CefResourceReadCallback> callback) override {
    const size_t remaining = body_.size() - offset_;
    if (remaining == 0) {
      bytes_read = 0;
      return false;
    }
    const int n = static_cast<int>(std::min<size_t>(static_cast<size_t>(bytes_to_read), remaining));
    memcpy(data_out, body_.data() + offset_, n);
    offset_ += n;
    bytes_read = n;
    return true;
  }

  void Cancel() override {}

 private:
  std::string mime_;
  std::string body_;
  size_t offset_ = 0;
  IMPLEMENT_REFCOUNTING(BufferResourceHandler);
};

/** 缺页提示：UI 产物没构建时给出可读的中文说明，而不是白屏 */
std::string MissingUiPage() {
  return R"(<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>TiBrowser</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#1c1c1e;color:#f2f2f7;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.card{max-width:620px;padding:32px 36px;border-radius:18px;background:#2c2c2e;
box-shadow:0 18px 50px rgba(0,0,0,.45)}
h1{margin:0 0 12px;font-size:20px;font-weight:600}
code{background:#3a3a3c;padding:2px 7px;border-radius:6px;font-size:13px}
p{margin:8px 0;color:#c7c7cc}a{color:#0a84ff}
</style></head><body><div class="card">
<h1>浏览器外壳 UI 尚未构建</h1>
<p>原生内核（Chromium / CEF）已正常启动，但没有找到 <code>ui/index.html</code>。</p>
<p>请在项目根目录执行：</p>
<p><code>npm run ui:build</code></p>
<p>然后重新运行 <code>TiBrowser.exe</code>。详细说明见 <code>docs/ARCHITECTURE.md</code>。</p>
</div></body></html>)";
}

class TibSchemeHandler : public CefResourceHandler {
 public:
  TibSchemeHandler() = default;

  bool Open(CefRefPtr<CefRequest> request,
            bool& handle_request,
            CefRefPtr<CefCallback> callback) override {
    // 注意：CEF 150 不保证在 IO 线程调用本方法（主文档请求可能在 UI 线程），
    // 这里刻意不加 CEF_REQUIRE_IO_THREAD()——加了会在页面加载时直接断言崩溃。
    // 处理器本身无可变共享状态，且未缓存跨线程数据，故不需要线程亲和。
    const std::string url = request->GetURL().ToString();
    const std::string path = ResolveTibResource(url);
    if (path.empty()) {
      body_ = MissingUiPage();
      mime_ = "text/html";
      status_ = 200;
      return true;
    }
    body_ = ReadFileToString(path);
    if (body_.empty()) {
      body_ = MissingUiPage();
      mime_ = "text/html";
      status_ = 200;
      return true;
    }
    mime_ = MimeForPath(path);
    // HTML 入口必须内联宿主脚本：window.tib / window.__tibHost / 首屏引导数据
    if (mime_ == "text/html") {
      body_ = InjectHostBridge(body_);
    }
    status_ = 200;
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response,
                          int64_t& response_length,
                          CefString& redirect_url) override {
    response->SetStatus(status_);
    response->SetMimeType(mime_);
    response->SetHeaderByName("Cache-Control", "no-cache", true);
    response_length = static_cast<int64_t>(body_.size());
  }

  bool Read(void* data_out,
            int bytes_to_read,
            int& bytes_read,
            CefRefPtr<CefResourceReadCallback> callback) override {
    const size_t remaining = body_.size() - offset_;
    if (remaining == 0) {
      bytes_read = 0;
      return false;
    }
    const int n = static_cast<int>(std::min<size_t>(static_cast<size_t>(bytes_to_read), remaining));
    memcpy(data_out, body_.data() + offset_, n);
    offset_ += n;
    bytes_read = n;
    return true;
  }

  void Cancel() override {}

 private:
  std::string body_;
  std::string mime_ = "text/html";
  int status_ = 200;
  size_t offset_ = 0;
  IMPLEMENT_REFCOUNTING(TibSchemeHandler);
};

class TibSchemeHandlerFactory : public CefSchemeHandlerFactory {
 public:
  CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser,
                                       CefRefPtr<CefFrame> frame,
                                       const CefString& scheme_name,
                                       CefRefPtr<CefRequest> request) override {
    return new TibSchemeHandler();
  }

 private:
  IMPLEMENT_REFCOUNTING(TibSchemeHandlerFactory);
};

}  // namespace

std::string ResolveTibResource(const std::string& url) {
  const std::string prefix = std::string(kSchemeUi) + "://";
  if (url.rfind(prefix, 0) != 0) return "";

  std::string rest = url.substr(prefix.size());
  const size_t slash = rest.find('/');
  std::string host = slash == std::string::npos ? rest : rest.substr(0, slash);
  std::string path = slash == std::string::npos ? "/" : rest.substr(slash);
  // 去掉查询串与片段
  for (const char sep : {'?', '#'}) {
    const size_t pos = path.find(sep);
    if (pos != std::string::npos) path = path.substr(0, pos);
  }
  if (path == "/" || path.empty()) path = "/index.html";
  path = PercentDecode(path);

  std::string base;
  if (host == kUiHost) {
    base = AppContext::Get().app_dir() + "\\ui";
  } else if (host == "res") {
    base = AppContext::Get().app_dir() + "\\resources";
  } else if (host == kNewTabHost) {
    base = AppContext::Get().app_dir() + "\\ui";
    path = "/index.html";
  } else {
    return "";
  }

  // 目录穿越防护：规范化后必须仍在 base 之内
  std::string full = base + path;
  for (auto& ch : full) {
    if (ch == '/') ch = '\\';
  }
  if (full.find("..") != std::string::npos) return "";
  return full;
}

void RegisterTibSchemeHandlers() {
  CefRegisterSchemeHandlerFactory(kSchemeUi, kUiHost, new TibSchemeHandlerFactory());
  CefRegisterSchemeHandlerFactory(kSchemeUi, kNewTabHost, new TibSchemeHandlerFactory());
  CefRegisterSchemeHandlerFactory(kSchemeUi, "res", new TibSchemeHandlerFactory());
}

}  // namespace tib
