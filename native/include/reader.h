// 阅读模式（feature 2 的 Chrome 常见能力补齐）
//
// 实现方式：把一段"提取正文 + 渲染阅读视图"的脚本注入当前页面。
// 为什么不用原生渲染：正文提取必须看到渲染后的 DOM（脚本生成的内容、懒加载段落都在 DOM 里），
// 而外壳 UI 是独立视图、拿不到网页的 DOM；因此只能注入脚本在页面里做，
// 再把结果用 console 消息（前缀 __TIB_READER__）回传给原生侧记日志、更新状态。
//
// 诚实说明：这是**启发式**提取（按段落文本量打分、剔除导航/侧栏/评论等），
// 不等同于 Chrome/Edge 的阅读视图，也不做分页、朗读、字号记忆。
#pragma once

#include "tib_common.h"

namespace tib {

/** 页面回传的阅读模式报告 */
struct ReaderReport {
  bool ok = false;
  bool active = false;
  std::string title;
  int chars = 0;
  int paragraphs = 0;
  std::string error;
};

/** 解析 __TIB_READER__ 后面的 JSON；失败返回 false */
bool ParseReaderReport(const std::string& json, ReaderReport& out);

/** 进入阅读模式的注入脚本 */
std::string ReaderEnterScript();

/** 退出阅读模式的注入脚本 */
std::string ReaderExitScript();

/** 报告前缀（与脚本里的字面量必须一致，改一处就要改两处 —— 这里集中定义避免写歪） */
inline constexpr char kReaderPrefix[] = "__TIB_READER__";

}  // namespace tib
