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

/** 处理注入脚本发来的宿主调用（浏览器进程 UI 线程调用） */
void HandleHostCall(CefRefPtr<CefBrowser> browser, const std::string& message);



/** 把外壳 UI 的浏览器对象与窗口绑定，供路由反查窗口 */
void RegisterWindowForChromeBrowser(CefRefPtr<CefBrowser> browser, TibWindow* window);
void UnregisterWindow(TibWindow* window);
TibWindow* FindWindowByChromeBrowser(CefRefPtr<CefBrowser> browser);

}  // namespace tib
