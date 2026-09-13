// 原生 API 分发的对外接口。
#pragma once

#include "tib_common.h"

#include <functional>

namespace tib {

class TibWindow;

/** DispatchApi 的处理结果类型 */
enum class ApiOutcome {
  /** 已同步处理，返回值即结果 JSON */
  Handled,
  /** 不是本层负责的方法，调用方继续尝试其它分发 */
  NotMine,
  /**
   * 已接管但结果稍后才有（转交边车的异步调用等）。
   * 此时返回值无意义，调用方**不要**发回执 —— 由回调负责。
   */
  Deferred
};

/**
 * 分发 UI 桥接契约里的方法（设置/书签/历史/下载/应用/扩展/账户/指纹/安全/AI 转发…）。
 *
 * @param window  当前窗口（可为空）
 * @param method  原生方法名（如 bookmarks.list）
 * @param args    参数对象（可为空）
 * @param reply   异步回执函数：ok=false 时 message 是中文原因。
 *                仅当返回 ApiOutcome::Deferred 时由本层稍后调用。
 * @return 处理结果类型。Handled 时返回值是结果 JSON；
 *         失败时返回 {"__error":"中文原因"}，由调用方转成失败回执。
 */
std::string DispatchApi(TibWindow* window, const std::string& method,
                        CefRefPtr<CefDictionaryValue> args,
                        const std::function<void(bool, const std::string&)>& reply,
                        ApiOutcome& outcome);

}  // namespace tib
