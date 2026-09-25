// 通用工具实现
#include "tib_common.h"

#include <windows.h>

#include <chrono>
#include <cstdio>
#include <fstream>
#include <random>
#include <sstream>

namespace tib {

AppContext& AppContext::Get() {
  static AppContext instance;
  return instance;
}

std::string MakeId() {
  static std::mt19937_64 rng(
      static_cast<uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count()));
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(16);
  for (int i = 0; i < 16; ++i) out.push_back(hex[rng() & 0xF]);
  return out;
}

std::string ResolveNavigationInput(const std::string& input, const std::string& search_engine) {
  // 去掉首尾空白
  size_t b = input.find_first_not_of(" \t\r\n");
  if (b == std::string::npos) return "";
  size_t e = input.find_last_not_of(" \t\r\n");
  std::string text = input.substr(b, e - b + 1);
  if (text.empty()) return "";

  // 已带协议：直接用
  if (text.find("://") != std::string::npos) return text;
  // 内置页面
  if (text.rfind("tib:", 0) == 0 || text.rfind("about:", 0) == 0) return text;

  // 判断"看起来像域名或主机"：不含空格，且有点号或就是 localhost
  const bool has_space = text.find(' ') != std::string::npos;
  const bool looks_host =
      !has_space && (text.find('.') != std::string::npos || text.rfind("localhost", 0) == 0);
  if (looks_host) return "https://" + text;

  // 否则按搜索处理
  std::string tmpl = "https://www.bing.com/search?q=";
  if (search_engine == "baidu") tmpl = "https://www.baidu.com/s?wd=";
  else if (search_engine == "google") tmpl = "https://www.google.com/search?q=";
  else if (search_engine == "duckduckgo") tmpl = "https://duckduckgo.com/?q=";

  // 最小化的百分号编码（够用即可，编码保留字符与空白）
  static const char* keep = "-_.~";
  std::string encoded;
  for (unsigned char c : text) {
    if (isalnum(c) || strchr(keep, c)) {
      encoded.push_back(static_cast<char>(c));
    } else {
      char buf[4];
      snprintf(buf, sizeof(buf), "%%%02X", c);
      encoded += buf;
    }
  }
  return tmpl + encoded;
}

std::string ReadFileToString(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return "";
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

std::string ExecutableDir() {
  wchar_t buffer[MAX_PATH] = {0};
  DWORD len = ::GetModuleFileNameW(nullptr, buffer, MAX_PATH);
  if (len == 0) return "";
  std::wstring wpath(buffer, len);
  size_t pos = wpath.find_last_of(L"\\/");
  if (pos == std::wstring::npos) return "";
  std::wstring wdir = wpath.substr(0, pos);
  // 转 UTF-8
  int size = ::WideCharToMultiByte(CP_UTF8, 0, wdir.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string dir(size > 0 ? size - 1 : 0, '\0');
  if (size > 1) ::WideCharToMultiByte(CP_UTF8, 0, wdir.c_str(), -1, dir.data(), size, nullptr, nullptr);
  return dir;
}

void Log(const std::string& message) {
  // 每条日志带「启动后毫秒数」与「线程号」，格式：[TiBrowser][+1234ms][t5678] 正文
  //
  // 为什么长期保留：本机的 CEF 崩溃（如 libcef 内部的 0xC0000005）不会写任何 FATAL 行，
  // 日志里"最后一条是什么、是哪个线程打的"就是唯一的现场。查"开第二个标签页随机崩溃"
  // 时正是靠它把崩溃时刻对齐到具体动作与线程上的。没有时间戳时只能按秒猜。
  static const auto t0 = std::chrono::steady_clock::now();
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now() - t0)
                      .count();
  std::string line = "[TiBrowser][+" + std::to_string(ms) + "ms][t" +
                     std::to_string(::GetCurrentThreadId()) + "] " + message + "\n";
  fputs(line.c_str(), stderr);
  const std::string& dir = AppContext::Get().user_data_dir();
  if (dir.empty()) return;
  std::ofstream out(dir + "\\tibrowser.log", std::ios::app | std::ios::binary);
  if (out) {
    out << line;
    // 必须立即 flush：崩溃时未落盘的日志会整块丢失，等于没有日志
    out.flush();
  }
}

bool SetClipboardText(const std::string& utf8) {
  // 剪贴板是进程外共享资源，OpenClipboard 可能被别的程序短暂占用 ——
  // 失败时如实返回 false（调用方会写"无法访问剪贴板"），不假装已经复制成功。
  if (!::OpenClipboard(nullptr)) return false;
  ::EmptyClipboard();
  const int len = ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
  if (len <= 0) {
    ::CloseClipboard();
    return false;
  }
  HGLOBAL mem = ::GlobalAlloc(GMEM_MOVEABLE, static_cast<SIZE_T>(len) * sizeof(wchar_t));
  if (!mem) {
    ::CloseClipboard();
    return false;
  }
  bool ok = false;
  if (void* dst = ::GlobalLock(mem)) {
    ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, static_cast<wchar_t*>(dst), len);
    ::GlobalUnlock(mem);
    ok = ::SetClipboardData(CF_UNICODETEXT, mem) != nullptr;
  }
  if (!ok) ::GlobalFree(mem);
  ::CloseClipboard();
  return ok;
}

}  // namespace tib
