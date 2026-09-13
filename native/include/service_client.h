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

}  // namespace tib
