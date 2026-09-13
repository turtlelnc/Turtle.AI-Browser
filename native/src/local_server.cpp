// 本地资源服务器实现（Winsock，最小 HTTP/1.1，仅回环）
#include "local_server.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <atomic>
#include <fstream>
#include <map>
#include <mutex>
#include <random>
#include <sstream>
#include <thread>

#pragma comment(lib, "ws2_32.lib")

namespace tib {
namespace {

SOCKET g_listen = INVALID_SOCKET;
std::atomic<bool> g_running{false};
std::thread g_thread;
int g_port = 0;
std::string g_token;
std::string g_root;
std::once_flag g_wsa_once;

/** 生成随机 URL token，避免本机其他进程读到我们的界面与内部数据 */
std::string MakeToken() {
  std::random_device rd;
  std::mt19937_64 rng(rd());
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (int i = 0; i < 32; ++i) out.push_back(hex[rng() & 0xF]);
  return out;
}

std::string MimeForPath(const std::string& path) {
  auto ends = [&](const char* s) {
    const size_t n = strlen(s);
    return path.size() >= n && path.compare(path.size() - n, n, s) == 0;
  };
  if (ends(".html")) return "text/html; charset=utf-8";
  if (ends(".js") || ends(".mjs")) return "text/javascript; charset=utf-8";
  if (ends(".css")) return "text/css; charset=utf-8";
  if (ends(".json")) return "application/json; charset=utf-8";
  if (ends(".svg")) return "image/svg+xml";
  if (ends(".png")) return "image/png";
  if (ends(".jpg") || ends(".jpeg")) return "image/jpeg";
  if (ends(".webp")) return "image/webp";
  if (ends(".woff2")) return "font/woff2";
  if (ends(".woff")) return "font/woff";
  if (ends(".ico")) return "image/x-icon";
  if (ends(".txt")) return "text/plain; charset=utf-8";
  if (ends(".map")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

std::string PercentDecode(const std::string& in) {
  std::string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size(); ++i) {
    if (in[i] == '%' && i + 2 < in.size()) {
      auto hexv = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      const int hi = hexv(in[i + 1]);
      const int lo = hexv(in[i + 2]);
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

void SendAll(SOCKET s, const std::string& data) {
  size_t sent = 0;
  while (sent < data.size()) {
    const int n = ::send(s, data.data() + sent, static_cast<int>(data.size() - sent), 0);
    if (n <= 0) return;
    sent += static_cast<size_t>(n);
  }
}

void SendResponse(SOCKET s, int status, const std::string& status_text, const std::string& mime,
                  const std::string& body) {
  std::ostringstream head;
  head << "HTTP/1.1 " << status << " " << status_text << "\r\n"
       << "Content-Type: " << mime << "\r\n"
       << "Content-Length: " << body.size() << "\r\n"
       << "Cache-Control: no-store\r\n"
       << "X-Content-Type-Options: nosniff\r\n"
       << "Connection: close\r\n\r\n";
  SendAll(s, head.str());
  SendAll(s, body);
}

std::string ReadFileBinary(const std::string& path) { return ReadFileToString(path); }

/** 宿主注入脚本内容：读取输出目录的 ui/tib-host.js（构建期由 vite.bridge.config.ts 生成） */
std::string HostBridgeScript() {
  static std::string cached;
  if (cached.empty()) {
    const std::string path = AppContext::Get().app_dir() + "\\ui\\tib-host.js";
    cached = ReadFileToString(path);
    if (cached.empty()) {
      Log("HostBridgeScript: 读取失败 " + path + "，原生桥将不可用");
      // 脚本缺失时给出可读提示，而不是让 UI 静默退化到 mock 桥
      cached =
          "console.error('[TiBrowser] 缺少 ui/tib-host.js，原生桥不可用');"
          "window.__tibHost={call:function(id,m){window.__tibDeliverReply&&"
          "window.__tibDeliverReply(id,false,null,'原生桥脚本缺失（ui/tib-host.js）')}};";
    } else {
      Log("HostBridgeScript: 已载入 " + path + "（" + std::to_string(cached.size()) + " 字节）");
    }
  }
  return cached;
}

/**
 * 把宿主脚本内联进 index.html。
 * 必须排在 UI 自身的 module 脚本之前，否则 React 首次渲染时拿不到 window.tib，
 * 会退化到 mock 桥并提示"未检测到原生宿主"。
 */
std::string InjectHostBridge(const std::string& html) {
  const AppContext& ctx = AppContext::Get();
  const std::string script = "<script>" + HostBridgeScript() + "</script><script>window.__TIB_BOOT__={skin:'" +
                             ctx.skin() + "',theme:'system',perf:'high'};</script>";
  const std::string marker = "<head>";
  const size_t pos = html.find(marker);
  if (pos == std::string::npos) return script + html;
  return html.substr(0, pos + marker.size()) + "\n" + script + html.substr(pos + marker.size());
}

/** 处理一个连接：只支持 GET，路径必须带 token */
void HandleClient(SOCKET client) {
  // 读取请求（足够容纳请求行与头部即可）
  std::string request;
  char buf[4096];
  for (;;) {
    const int n = ::recv(client, buf, sizeof(buf), 0);
    if (n <= 0) break;
    request.append(buf, static_cast<size_t>(n));
    if (request.find("\r\n\r\n") != std::string::npos) break;
    if (request.size() > 16384) break;
  }

  const size_t line_end = request.find("\r\n");
  if (line_end == std::string::npos) {
    SendResponse(client, 400, "Bad Request", "text/plain; charset=utf-8", "请求格式错误");
    return;
  }
  std::istringstream line(request.substr(0, line_end));
  std::string method;
  std::string target;
  std::string version;
  line >> method >> target >> version;
  if (method != "GET") {
    SendResponse(client, 405, "Method Not Allowed", "text/plain; charset=utf-8", "只支持 GET");
    return;
  }

  // 形如 /<token>/ui/index.html
  std::string path = target;
  const size_t query = path.find('?');
  if (query != std::string::npos) path = path.substr(0, query);

  if (path.rfind("/" + g_token + "/", 0) != 0) {
    Log("本地服务器 403：" + path + "（令牌不匹配）");
    SendResponse(client, 403, "Forbidden", "text/plain; charset=utf-8",
                 "缺少或错误的访问令牌：请通过 TiBrowser 打开的地址访问");
    return;
  }
  std::string rel = PercentDecode(path.substr(g_token.size() + 2));

  // 目录穿越防护 + 只允许白名单子目录
  if (rel.find("..") != std::string::npos || rel.empty()) {
    SendResponse(client, 400, "Bad Request", "text/plain; charset=utf-8", "非法路径");
    return;
  }
  static const char* kAllowed[] = {"ui/", "resources/"};
  bool allowed = false;
  for (const char* prefix : kAllowed) {
    if (rel.rfind(prefix, 0) == 0) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    SendResponse(client, 404, "Not Found", "text/plain; charset=utf-8", "未找到资源");
    return;
  }

  for (auto& ch : rel) {
    if (ch == '/') ch = '\\';
  }
  const std::string full = g_root + "\\" + rel;
  std::string body = ReadFileBinary(full);
  if (body.empty()) {
    SendResponse(client, 404, "Not Found", "text/plain; charset=utf-8", "未找到资源：" + rel);
    return;
  }
  const std::string mime = MimeForPath(full);
  // HTML 入口内联宿主桥：window.tib / __tibHost / 首屏引导数据
  if (mime.rfind("text/html", 0) == 0) {
    body = InjectHostBridge(body);
  }
  Log("本地服务器 200：" + rel + " → " + mime + " " + std::to_string(body.size()) + " 字节");
  SendResponse(client, 200, "OK", mime, body);
}

void ServerLoop() {
  while (g_running.load()) {
    sockaddr_in addr{};
    int addr_len = sizeof(addr);
    SOCKET client = ::accept(g_listen, reinterpret_cast<sockaddr*>(&addr), &addr_len);
    if (client == INVALID_SOCKET) {
      if (!g_running.load()) break;
      continue;
    }
    // 单线程串行处理即可：外壳 UI 的资源数量很少，且全部命中本地磁盘
    HandleClient(client);
    ::closesocket(client);
  }
}

}  // namespace

int StartLocalServer(const std::string& root_dir) {
  if (g_running.load()) return g_port;

  std::call_once(g_wsa_once, [] {
    WSADATA wsa{};
    ::WSAStartup(MAKEWORD(2, 2), &wsa);
  });

  g_root = root_dir;
  g_token = MakeToken();

  g_listen = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (g_listen == INVALID_SOCKET) {
    Log("本地服务器：创建套接字失败，错误码 " + std::to_string(::WSAGetLastError()));
    return 0;
  }
  BOOL reuse = TRUE;
  ::setsockopt(g_listen, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse),
               sizeof(reuse));

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = 0;  // 让系统分配空闲端口
  ::inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);  // 只监听回环
  if (::bind(g_listen, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == SOCKET_ERROR) {
    Log("本地服务器：绑定 127.0.0.1 失败，错误码 " + std::to_string(::WSAGetLastError()));
    ::closesocket(g_listen);
    g_listen = INVALID_SOCKET;
    return 0;
  }
  if (::listen(g_listen, 16) == SOCKET_ERROR) {
    Log("本地服务器：listen 失败，错误码 " + std::to_string(::WSAGetLastError()));
    ::closesocket(g_listen);
    g_listen = INVALID_SOCKET;
    return 0;
  }

  sockaddr_in bound{};
  int bound_len = sizeof(bound);
  if (::getsockname(g_listen, reinterpret_cast<sockaddr*>(&bound), &bound_len) == 0) {
    g_port = ntohs(bound.sin_port);
  }
  if (g_port == 0) {
    Log("本地服务器：无法获取监听端口");
    ::closesocket(g_listen);
    g_listen = INVALID_SOCKET;
    return 0;
  }

  g_running.store(true);
  g_thread = std::thread(ServerLoop);
  Log("本地服务器已启动：http://127.0.0.1:" + std::to_string(g_port) + "/（仅回环，需令牌）");
  return g_port;
}

void StopLocalServer() {
  if (!g_running.exchange(false)) return;
  if (g_listen != INVALID_SOCKET) {
    ::closesocket(g_listen);
    g_listen = INVALID_SOCKET;
  }
  if (g_thread.joinable()) g_thread.join();
  Log("本地服务器已停止");
}

std::string UiUrl() {
  if (g_port == 0) return "";
  return "http://127.0.0.1:" + std::to_string(g_port) + "/" + g_token + "/ui/index.html";
}

std::string NewTabUrl() {
  if (g_port == 0) return "about:blank";
  return "http://127.0.0.1:" + std::to_string(g_port) + "/" + g_token +
         "/ui/index.html#/newtab";
}

std::string DiagnosticProbeUrl() {
  if (g_port == 0) return "";
  return "http://127.0.0.1:" + std::to_string(g_port) + "/" + g_token +
         "/resources/diag/script-probe.html";
}

}  // namespace tib
