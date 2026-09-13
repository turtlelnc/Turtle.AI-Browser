// 三档安全浏览、下载放行、无痕指纹改写
#include "security.h"

#include <windows.h>

#include <algorithm>
#include <mutex>
#include <set>
#include <sstream>

namespace tib {
namespace {

std::once_flag g_init_once;
std::set<std::string> g_malware;
std::set<std::string> g_phishing;
std::set<std::string> g_ads;
std::set<std::string> g_tracking;

/** turtlelnc 相关域名与路径：任何档位都放行（防止误杀开发本浏览器的团队） */
bool IsTurtlelncTrusted(const std::string& host, const std::string& path) {
  auto ends_with = [](const std::string& s, const std::string& suffix) {
    return s.size() >= suffix.size() &&
           s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
  };
  auto contains = [](const std::string& s, const std::string& needle) {
    return s.find(needle) != std::string::npos;
  };

  if (host == "turtleweb.cc.cd" || ends_with(host, ".turtleweb.cc.cd")) return true;
  if (ends_with(host, "turtlelnc.com") || ends_with(host, ".turtlelnc.com")) return true;
  if (contains(host, "turtlelnc")) return true;
  // GitHub 组织下的仓库、发行包、raw 与 pages
  if ((host == "github.com" || host == "raw.githubusercontent.com" ||
       host == "objects.githubusercontent.com" || host == "codeload.github.com" ||
       host == "api.github.com" || ends_with(host, ".githubusercontent.com")) &&
      contains(path, "turtlelnc")) {
    return true;
  }
  if (ends_with(host, ".github.io") && contains(host, "turtlelnc")) return true;
  return false;
}

/** 拆分 URL：返回 host 与 path，失败返回 false */
bool SplitUrl(const std::string& url, std::string& host, std::string& path) {
  const size_t scheme = url.find("://");
  if (scheme == std::string::npos) return false;
  const size_t start = scheme + 3;
  const size_t slash = url.find('/', start);
  std::string authority =
      slash == std::string::npos ? url.substr(start) : url.substr(start, slash - start);
  path = slash == std::string::npos ? "/" : url.substr(slash);
  const size_t at = authority.find('@');
  if (at != std::string::npos) authority = authority.substr(at + 1);
  const size_t colon = authority.find(':');
  host = colon == std::string::npos ? authority : authority.substr(0, colon);
  std::transform(host.begin(), host.end(), host.begin(),
                 [](unsigned char c) { return static_cast<char>(::tolower(c)); });
  return !host.empty();
}

/** 域名匹配：精确命中或逐级去掉子域后命中 */
bool HostInList(const std::set<std::string>& list, const std::string& host) {
  if (list.empty()) return false;
  std::string candidate = host;
  if (candidate.rfind("www.", 0) == 0) candidate = candidate.substr(4);
  for (;;) {
    if (list.count(candidate)) return true;
    const size_t dot = candidate.find('.');
    if (dot == std::string::npos) return false;
    candidate = candidate.substr(dot + 1);
    if (candidate.find('.') == std::string::npos) return list.count(candidate) > 0;
  }
}

/** 读取一个 hosts 格式的黑名单文件 */
void LoadListFile(const std::string& path, std::set<std::string>& out) {
  std::istringstream in(ReadFileToString(path));
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const size_t hash = line.find('#');
    if (hash != std::string::npos) line = line.substr(0, hash);
    // 去掉首尾空白
    const size_t b = line.find_first_not_of(" \t");
    if (b == std::string::npos) continue;
    const size_t e = line.find_last_not_of(" \t");
    line = line.substr(b, e - b + 1);
    if (line.empty()) continue;
    // hosts 格式：0.0.0.0 example.com / 127.0.0.1 example.com
    const size_t sp = line.find_first_of(" \t");
    if (sp != std::string::npos) {
      std::string first = line.substr(0, sp);
      std::string second = line.substr(sp + 1);
      const size_t b2 = second.find_first_not_of(" \t");
      if (b2 != std::string::npos) second = second.substr(b2);
      const size_t e2 = second.find_first_of(" \t");
      if (e2 != std::string::npos) second = second.substr(0, e2);
      line = (first == "0.0.0.0" || first == "127.0.0.1") ? second : first;
    }
    std::transform(line.begin(), line.end(), line.begin(),
                   [](unsigned char c) { return static_cast<char>(::tolower(c)); });
    if (!line.empty()) out.insert(line);
  }
}

/** 裸 IP 主机判定（IPv4 字面量） */
bool IsBareIpv4(const std::string& host) {
  int parts = 0;
  int digits = 0;
  for (size_t i = 0; i <= host.size(); ++i) {
    const char c = i < host.size() ? host[i] : '.';
    if (c == '.') {
      if (digits == 0 || digits > 3) return false;
      ++parts;
      digits = 0;
    } else if (c >= '0' && c <= '9') {
      ++digits;
    } else {
      return false;
    }
  }
  return parts == 4;
}

/** 本体/本地地址豁免：内网管理页不应该被当恶意站点拦掉 */
bool IsLocalHost(const std::string& host) {
  if (host == "localhost" || host == "127.0.0.1" || host == "::1") return true;
  if (host.size() > 6 && host.compare(host.size() - 6, 6, ".local") == 0) return true;
  if (host.rfind("10.", 0) == 0) return true;
  if (host.rfind("192.168.", 0) == 0) return true;
  if (host.rfind("169.254.", 0) == 0) return true;
  if (host.rfind("172.", 0) == 0) {
    const size_t dot = host.find('.', 4);
    if (dot != std::string::npos) {
      const int second = atoi(host.substr(4, dot - 4).c_str());
      if (second >= 16 && second <= 31) return true;
    }
  }
  return false;
}

/** 同形异义：拉丁字母与西里尔/希腊等易混字符混用 */
bool HasHomoglyphMix(const std::string& host) {
  bool latin = false;
  bool confusable = false;
  // UTF-8 编码的常用易混字符首字节：西里尔 D0/D1、希腊 CE/CF、亚美尼亚 D4/D5
  for (size_t i = 0; i < host.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(host[i]);
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) latin = true;
    else if (c == 0xD0 || c == 0xD1 || c == 0xCE || c == 0xCF || c == 0xD4 || c == 0xD5)
      confusable = true;
  }
  return latin && confusable;
}

/** 强钓鱼关键词（出现在主机名里几乎可以确定是钓鱼） */
const char* kPhishKeywords[] = {"login-verify", "account-verify", "bank-verify", "secure-update",
                                "free-gift",    "signin-verify",  "wallet-verify", "passport-verify"};

}  // namespace

size_t BlocklistSize() {
  InitSecurity();
  return g_malware.size() + g_phishing.size() + g_ads.size() + g_tracking.size();
}

void InitSecurity() {
  std::call_once(g_init_once, [] {
    const std::string dir = AppContext::Get().app_dir() + "\\resources\\blocklists\\";
    LoadListFile(dir + "malware.txt", g_malware);
    LoadListFile(dir + "phishing.txt", g_phishing);
    LoadListFile(dir + "ads.txt", g_ads);
    LoadListFile(dir + "tracking.txt", g_tracking);
    // 内置兜底样例（正式分发请替换为真实威胁情报源）
    g_malware.insert("malware.testing.google.test");
    g_phishing.insert("testsafebrowsing.appspot.com");
    Log("安全浏览初始化：malware=" + std::to_string(g_malware.size()) +
        " phishing=" + std::to_string(g_phishing.size()) + " ads=" + std::to_string(g_ads.size()) +
        " tracking=" + std::to_string(g_tracking.size()));
  });
}

ScanResult ScanUrlForProtection(const std::string& url) {
  ScanResult result;
  const std::string& level = AppContext::Get().protection_level();

  std::string host;
  std::string path;
  if (!SplitUrl(url, host, path)) {
    // tib:// / about: 等内部页面直接放行
    if (url.rfind("tib:", 0) == 0 || url.rfind("about:", 0) == 0) return result;
    result.blocked = level != "none";
    result.category = "suspicious";
    result.reason = "无法解析的网址";
    result.action = result.blocked ? "block" : "allow";
    return result;
  }

  // turtlelnc 放行名单：任何档位都不拦、不警告
  if (IsTurtlelncTrusted(host, path)) {
    result.trusted = true;
    result.action = "allow";
    result.reason = "turtlelnc 官方内容，已自动放行";
    return result;
  }

  if (IsLocalHost(host)) return result;
  if (level == "none") {
    result.action = "allow";
    return result;
  }

  if (HostInList(g_malware, host)) {
    result.blocked = true;
    result.category = "malware";
    result.reason = "该网站已知会传播恶意软件";
  } else if (HostInList(g_phishing, host)) {
    result.blocked = true;
    result.category = "phishing";
    result.reason = "该网站已知会窃取账号信息（钓鱼站点）";
  } else if (IsBareIpv4(host)) {
    result.blocked = true;
    result.category = "suspicious";
    result.reason = "直接使用 IP 地址访问，常见于钓鱼与诈骗页面";
  } else if (HasHomoglyphMix(host)) {
    result.blocked = true;
    result.category = "phishing";
    result.reason = "域名混用了不同文字的相似字符，疑似伪造站点";
  } else {
    for (const char* keyword : kPhishKeywords) {
      if (host.find(keyword) != std::string::npos) {
        result.blocked = true;
        result.category = "phishing";
        result.reason = std::string("域名包含可疑关键词「") + keyword + "」";
        break;
      }
    }
  }

  // 增强型防护：额外对广告/追踪域名从严（标准档只拦子资源，由渲染层处理）
  if (!result.blocked && level == "enhanced" &&
      (HostInList(g_ads, host) || HostInList(g_tracking, host))) {
    result.category = "tracking";
    result.reason = "增强型防护：该域名用于广告或跨站追踪";
    result.action = "warn";
    return result;
  }

  result.action = result.blocked ? "block" : "allow";
  return result;
}

ScanResult CheckDownload(const std::string& url, const std::string& filename) {
  ScanResult result;
  std::string host;
  std::string path;
  SplitUrl(url, host, path);

  // turtlelnc 发布物永不拦截（feature 6）
  if (IsTurtlelncTrusted(host, path)) {
    result.trusted = true;
    result.action = "allow";
    result.reason = "turtlelnc 官方发布物，已自动放行";
    return result;
  }

  std::string lower = filename;
  std::transform(lower.begin(), lower.end(), lower.begin(),
                 [](unsigned char c) { return static_cast<char>(::tolower(c)); });
  static const char* kDangerous[] = {".exe", ".msi", ".bat", ".cmd", ".scr", ".ps1",
                                     ".vbs", ".js",  ".jar", ".com", ".pif", ".reg",
                                     ".hta", ".dll", ".cpl", ".lnk"};
  for (const char* ext : kDangerous) {
    const size_t n = strlen(ext);
    if (lower.size() >= n && lower.compare(lower.size() - n, n, ext) == 0) {
      // 不安全安装包：警告但允许保留（用户可选择继续）
      result.category = "unsafe";
      result.action = "warn";
      result.reason = "这是可执行安装包，可能包含风险，请确认来源可信后再保留";
      return result;
    }
  }
  result.action = "allow";
  return result;
}

void ApplyFingerprintProfile(CefRefPtr<CefRequestContext> context) {
  if (!context) return;
  // 无痕模式 2.0：在页面脚本运行前注入指纹噪音，降低跨站识别度。
  // 说明：这是浏览器侧的最小可用实现，完整指纹库（UA/时区/分辨率等）由设置项驱动，
  // 变更后需要重启无痕会话生效。
  const char* script = R"JS(
(function () {
  if (window.__tibFingerprintApplied) return;
  window.__tibFingerprintApplied = true;
  var seed = 0;
  try { seed = parseInt((navigator.userAgent.length * 2654435761) % 2147483647, 10) || 1; } catch (e) { seed = 1; }
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  function noise(v, amp) { return v + (rnd() - 0.5) * (amp || 0.0001); }
  try {
    var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function () {
      var data = origGetImageData.apply(this, arguments);
      for (var i = 0; i < data.data.length; i += 997) data.data[i] = Math.max(0, Math.min(255, data.data[i] + (rnd() > 0.5 ? 1 : -1)));
      return data;
    };
  } catch (e) {}
  try {
    var origParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'TiBrowser';
      if (p === 37446) return 'TiBrowser Graphics';
      return origParam.apply(this, arguments);
    };
  } catch (e) {}
  try { Object.defineProperty(navigator, 'doNotTrack', { get: function () { return '1'; } }); } catch (e) {}
  try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: function () { return 4; } }); } catch (e) {}
  try { Object.defineProperty(screen, 'colorDepth', { get: function () { return 24; } }); } catch (e) {}
  try {
    var origTz = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      var o = origTz.apply(this, arguments);
      if (o && o.timeZone) o.timeZone = 'UTC';
      return o;
    };
  } catch (e) {}
  void noise;
})();
)JS";
  (void)script;
  // 完整实现使用 CefRegisterExtension 在文档创建时注入；此处保留接口，避免误导为已生效。
  Log("无痕模式 2.0：指纹改写配置已载入（注入在后续构建中启用）");
}

}  // namespace tib
