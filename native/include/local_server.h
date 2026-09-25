// 本地 UI/内置页面服务器（仅监听 127.0.0.1）
//
// 为什么不用自定义协议：本机实测 tib:// 在 CefBrowserView 里始终返回
// ERR_UNKNOWN_URL_SCHEME（AddCustomScheme 返回 true 也没用），而内置页面是浏览器
// 外壳的一部分，不能因此不可用。改用回环 HTTP 有几个额外好处：
//   1. 是 trustworthy origin，ES module / fetch / 各类现代 API 都正常工作；
//   2. 可以用普通浏览器直接打开同一个地址做 UI 走查与调试；
//   3. 与边车的本地控制接口同构，架构上只有一套"本地 HTTP"心智模型。
// 安全：只绑定 127.0.0.1；请求路径必须带正确的随机 token；只提供白名单目录内的文件。
#pragma once

#include "tib_common.h"

namespace tib {

/**
 * 启动本地资源服务器。
 * @param root_dir 要提供的根目录（通常是程序目录）
 * @return 监听到的端口；失败返回 0
 */
int StartLocalServer(const std::string& root_dir);

/** 停止服务器并释放端口 */
void StopLocalServer();

/** 外壳 UI 的完整访问地址（含 token），服务器未启动时返回空串 */
std::string UiUrl();

/** 新标签页的地址（同样是本地 HTTP） */
std::string NewTabUrl();

/** 诊断用：脚本执行探针页的地址（--diag 时由原生自动打开） */
std::string DiagnosticProbeUrl();

/**
 * 验收用：一篇足够长的文章页（--tib-reader-probe 时作为首个标签页打开）。
 * 页面里刻意混入导航 / 侧栏 / 广告 / 评论 / 页脚 / 脚本生成内容，
 * 用来验证阅读模式的提取到底有没有做取舍，而不是把整页原样搬进覆盖层。
 */
std::string ArticleProbeUrl();

/**
 * 验收用：会触发下载的探针地址。
 * 这个地址的响应带 Content-Disposition: attachment，导航过去必然走下载管线，
 * 于是"下载能落盘、能记进下载列表、能过安全判定"这三件事可以被自动化验证，
 * 而不必依赖外网某个真实的下载链接。
 * @param filename 期望的落盘文件名（留空为 tib-download-probe.bin）；
 *                 用 setup.exe 这类名字可以验证"不安全安装包只警告不拦截"。
 */
std::string DownloadProbeUrl(const std::string& filename = "");

/** 宿主注入脚本内容（内联进 HTML 的 window.tib / __tibHost） */
std::string HostBridgeScript();

}  // namespace tib
