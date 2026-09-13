// tib:// 自定义协议：把磁盘上的 ui/ 目录与 resources/ 提供给浏览器外壳页面
#include "tib_common.h"

namespace tib {

/** 把 tib:// 请求映射到磁盘文件；带目录穿越防护 */
std::string ResolveTibResource(const std::string& url);

/** 注册 tib:// 的 scheme handler factory（必须在浏览器进程创建窗口前调用） */
void RegisterTibSchemeHandlers();

}  // namespace tib
