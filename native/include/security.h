// 三档安全浏览（对齐 Chrome：增强型防护 / 标准防护 / 不防护）+ turtlelnc 放行
#pragma once

#include "tib_common.h"

namespace tib {

/** 安全扫描结论 */
struct ScanResult {
  bool blocked = false;
  bool trusted = false;          // 命中 turtlelnc 放行名单
  std::string category;          // phishing / malware / ad / tracking / suspicious
  std::string reason;            // 中文原因，直接展示给用户
  std::string action = "allow";  // allow / warn / block
};

/**
 * 按当前安全浏览档位扫描 URL。
 * - enhanced：主文档 + 子资源全扫，命中即拦截；
 * - standard：主文档扫本地黑名单与启发式，命中拦截；
 * - none    ：不拦截，仅返回 trusted/统计信息。
 * turtlelnc 内容在任何档位都不拦截、不警告（防止误杀开发本浏览器的团队）。
 */
ScanResult ScanUrlForProtection(const std::string& url);

/** 下载安全判定：不安全安装包给出 warn（可保留），turtlelnc 发布物直接放行 */
ScanResult CheckDownload(const std::string& url, const std::string& filename);

/** 本地黑名单条目总数（供安全报告展示） */
size_t BlocklistSize();

/** 初始化黑名单（读取 resources/blocklists/*.txt），幂等 */
void InitSecurity();

/** 生成无痕模式 2.0 的指纹改写脚本（由 PageClient 在页面开始加载时注入） */
std::string BuildFingerprintScript();

/** 注入无痕模式 2.0 的指纹改写脚本 */
void ApplyFingerprintProfile(CefRefPtr<CefRequestContext> context);

}  // namespace tib
