// 与 Node 边车进程（AI / 存储 / 自动化）的通信接口
#pragma once

#include "tib_common.h"

namespace tib {

/**
 * 边车状态。边车是独立进程，负责 AI 流式对话、MCP、OAuth、办公/开发模式与自动化 API；
 * 浏览器在「即开即用」能效模式下可以不启动它，此时 AI 能力降级。
 */
struct ServiceState {
  bool running = false;
  int port = 0;
  std::string version;
  std::string capabilities;
};

/** 读取握手文件（<userData>/service.json），返回当前边车状态 */
ServiceState ReadServiceState();

/** 启动边车进程（若已在运行则直接返回状态） */
ServiceState StartService(const std::string& energy_mode);

/** 停止边车进程 */
void StopService();

/** 供路由使用：service.status 的 JSON 响应体 */
std::string ServiceStatusJson();

/** 供路由使用：automation.info 的 JSON 响应体（本地控制接口信息） */
std::string AutomationInfoJson();

/** 边车 RPC 调用完成后的回调：ok=false 时 error 是中文原因 */
using SidecarCallback = std::function<void(bool ok, const std::string& body_or_error)>;

/**
 * 异步调用边车的 RPC 方法。
 *
 * 为什么是异步：CEF 的网络请求本身是异步的（CefURLRequest），而 UI 的桥接契约是 Promise，
 * 所以「原生 → 边车」这一段天然异步；原生侧收到结果后再回执给渲染进程。
 * 同步等待会造成 UI 卡死与线程死锁，因此这里坚持异步。
 *
 * @param method  边车方法名（如 ai.mode.get）
 * @param params  参数 JSON（对象字面量，可为空字符串表示 {}）
 * @param callback 完成回调（在 CEF UI 线程调用）
 */
void CallSidecarAsync(const std::string& method, const std::string& params,
                      SidecarCallback callback);

/** 边车是否就绪（读取握手文件） */
bool SidecarReady();

}  // namespace tib
