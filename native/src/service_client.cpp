// 边车进程通信实现
#include "service_client.h"

#include "router.h"

#include <windows.h>

namespace tib {
namespace {

constexpr char kHandshakeFile[] = "\\service.json";
constexpr char kAutomationFile[] = "\\automation.json";

/** 极简 JSON 字段提取（握手文件是我们自己写的，格式固定，无需完整解析器） */
std::string ExtractString(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const size_t pos = json.find(needle);
  if (pos == std::string::npos) return "";
  const size_t colon = json.find(':', pos + needle.size());
  if (colon == std::string::npos) return "";
  size_t p = json.find('"', colon);
  if (p == std::string::npos) return "";
  const size_t end = json.find('"', p + 1);
  if (end == std::string::npos) return "";
  return json.substr(p + 1, end - p - 1);
}

int ExtractInt(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const size_t pos = json.find(needle);
  if (pos == std::string::npos) return 0;
  const size_t colon = json.find(':', pos + needle.size());
  if (colon == std::string::npos) return 0;
  return atoi(json.c_str() + colon + 1);
}

PROCESS_INFORMATION g_service_process{};
bool g_service_started = false;

}  // namespace

ServiceState ReadServiceState() {
  ServiceState state;
  const std::string path = AppContext::Get().user_data_dir() + kHandshakeFile;
  const std::string json = ReadFileToString(path);
  if (json.empty()) return state;
  state.port = ExtractInt(json, "port");
  state.version = ExtractString(json, "version");
  state.capabilities = ExtractString(json, "capabilities");
  state.running = state.port > 0;
  return state;
}

ServiceState StartService(const std::string& energy_mode) {
  ServiceState current = ReadServiceState();
  if (current.running) return current;

  // 即开即用模式：不启动边车，把内存让给其他应用（AI 能力降级并提示用户）
  if (energy_mode == "ondemand") {
    Log("能效模式为「即开即用」，本次不启动 AI 边车进程");
    return current;
  }

  const std::string exe = AppContext::Get().app_dir() + "\\tib-service.exe";
  if (GetFileAttributesA(exe.c_str()) == INVALID_FILE_ATTRIBUTES) {
    Log("未找到边车可执行文件 tib-service.exe，AI 能力降级（仅本地功能可用）");
    return current;
  }

  std::string cmd = "\"" + exe + "\" --headless";
  STARTUPINFOA si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  if (!CreateProcessA(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                      AppContext::Get().user_data_dir().c_str(), &si, &pi)) {
    Log("启动边车失败，错误码 " + std::to_string(GetLastError()));
    return current;
  }
  g_service_process = pi;
  g_service_started = true;
  Log("边车进程已启动，pid=" + std::to_string(pi.dwProcessId));

  // 等待握手完成（最多 10 秒）
  for (int i = 0; i < 100; ++i) {
    Sleep(100);
    ServiceState s = ReadServiceState();
    if (s.running) return s;
  }
  Log("边车握手超时，AI 能力暂不可用");
  return ReadServiceState();
}

void StopService() {
  if (!g_service_started) return;
  TerminateProcess(g_service_process.hProcess, 0);
  CloseHandle(g_service_process.hProcess);
  CloseHandle(g_service_process.hThread);
  g_service_started = false;
  Log("边车进程已停止");
}

std::string ServiceStatusJson() {
  const ServiceState state = ReadServiceState();
  return "{\"running\":" + std::string(state.running ? "true" : "false") +
         ",\"port\":" + std::to_string(state.port) + ",\"version\":\"" +
         JsonEscape(state.version) + "\",\"mode\":\"" + AppContext::Get().energy_mode() + "\"}";
}

std::string AutomationInfoJson() {
  const std::string path = AppContext::Get().user_data_dir() + kAutomationFile;
  const std::string json = ReadFileToString(path);
  const bool enabled = !json.empty() && json.find("\"enabled\":true") != std::string::npos;
  const std::string token = ExtractString(json, "token");
  const int port = ExtractInt(json, "port");
  const std::string base = "http://127.0.0.1:" + std::to_string(port);
  return "{\"enabled\":" + std::string(enabled ? "true" : "false") + ",\"baseUrl\":\"" + base +
         "\",\"token\":\"" + JsonEscape(token) +
         "\",\"docs\":\"docs/AUTOMATION.md\",\"note\":\"默认关闭；开启后本机 AI 工具可通过该地址驱动浏览器\"}";
}

}  // namespace tib
