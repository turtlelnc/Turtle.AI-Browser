// 消息路由与查询处理器的对外接口
#pragma once

#include "tib_common.h"

namespace tib {

class TibWindow;

/** JSON 字符串转义 */
std::string JsonEscape(const std::string& in);

/** 解析 JSON 文本；失败时返回空 CefValue 并返回 false */
bool ParseJson(const std::string& text, CefRefPtr<CefValue>& out);

/** 取字典里的字符串参数 */
std::string GetStringArg(CefRefPtr<CefDictionaryValue> dict, const char* key,
                         const std::string& fallback);
/** 取字典里的数值参数（兼容 int / double） */
double GetDoubleArg(CefRefPtr<CefDictionaryValue> dict, const char* key, double fallback);
/** 取字典里的布尔参数 */
bool GetBoolArg(CefRefPtr<CefDictionaryValue> dict, const char* key, bool fallback);

/** 创建 tib 专用的消息路由 */
CefRefPtr<CefMessageRouterBrowserSide> CreateTibRouter();
/** 创建查询处理器。注意：Handler 不是引用计数对象，路由接管其所有权，返回裸指针 */
CefMessageRouterBrowserSide::Handler* CreateTibQueryHandler();

/** 把外壳 UI 的浏览器对象与窗口绑定，供路由反查窗口 */
void RegisterWindowForChromeBrowser(CefRefPtr<CefBrowser> browser, TibWindow* window);
void UnregisterWindow(TibWindow* window);
TibWindow* FindWindowByChromeBrowser(CefRefPtr<CefBrowser> browser);

}  // namespace tib
