// 边车进程通信实现
#include "service_client.h"

#include "router.h"

#include <windows.h>

#include <functional>

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

/** 读取握手文件里的 bearer token：边车用它做 RPC 鉴权 */
std::string ReadServiceToken() {
  const std::string path = AppContext::Get().user_data_dir() + kHandshakeFile;
  return ExtractString(ReadFileToString(path), "token");
}

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

  // 边车以 Node 脚本形式随浏览器分发：<程序目录>\service\index.js
  // （Node 是运行边车的前提；缺失时 AI 能力降级，浏览器本身功能不受影响）
  const std::string script = AppContext::Get().app_dir() + "\\service\\index.js";
  if (GetFileAttributesA(script.c_str()) == INVALID_FILE_ATTRIBUTES) {
    Log("未找到边车脚本 service\\index.js，AI 能力降级（仅本地功能可用）");
    return current;
  }

  // 找一个可用的 node 解释器：优先程序目录内自带，其次 PATH
  std::string node = AppContext::Get().app_dir() + "\\node.exe";
  if (GetFileAttributesA(node.c_str()) == INVALID_FILE_ATTRIBUTES) {
    node = "node";
  }

  // 显式把用户数据目录传给边车：两侧必须指向同一目录，
  // 否则握手文件互相看不见（表现为"边车已启动"但"握手超时"）。
  std::string cmd = "\"" + node + "\" \"" + script + "\" --headless --user-data \"" +
                    AppContext::Get().user_data_dir() + "\"";
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

bool SidecarReady() { return ReadServiceState().running; }

/**
 * 边车 RPC 的异步实现。
 *
 * 用 CefURLRequest 而不是 WinHTTP：前者走 Chromium 的网络栈，
 * 与浏览器共享代理/证书设置，行为与页面请求一致。
 */
namespace {

/** 从响应体里取出 result / error */
std::string ExtractSidecarResult(const std::string& body, bool& ok, std::string& error) {
  ok = false;
  CefRefPtr<CefValue> root = CefParseJSON(body, JSON_PARSER_RFC);
  if (!root || root->GetType() != VTYPE_DICTIONARY) {
    error = "边车返回了无法解析的响应";
    return "";
  }
  CefRefPtr<CefDictionaryValue> d = root->GetDictionary();
  if (d->HasKey("ok") && d->GetType("ok") == VTYPE_BOOL && d->GetBool("ok")) {
    ok = true;
    if (d->HasKey("result")) {
      return CefWriteJSON(d->GetValue("result"), JSON_WRITER_DEFAULT).ToString();
    }
    return "null";
  }
  if (d->HasKey("error") && d->GetType("error") == VTYPE_DICTIONARY) {
    CefRefPtr<CefDictionaryValue> e = d->GetDictionary("error");
    if (e->HasKey("message") && e->GetType("message") == VTYPE_STRING) {
      error = e->GetString("message").ToString();
      return "";
    }
  }
  error = "边车未返回结果";
  return "";
}

}  // namespace

void CallSidecarAsync(const std::string& method, const std::string& params,
                      SidecarCallback callback) {
  const ServiceState state = ReadServiceState();
  if (!state.running) {
    if (callback) callback(false, "边车未运行");
    return;
  }
  const std::string url =
      "http://127.0.0.1:" + std::to_string(state.port) + "/rpc/" + method;

  CefRefPtr<CefRequest> request = CefRequest::Create();
  request->SetURL(url);
  request->SetMethod("POST");
  CefRequest::HeaderMap headers;
  headers.insert(std::make_pair("Content-Type", "application/json"));
  // 握手文件里的 token：边车用它做鉴权
  headers.insert(std::make_pair("Authorization", "Bearer " + ReadServiceToken()));
  request->SetHeaderMap(headers);
  const std::string body = params.empty() ? "{}" : params;
  CefRefPtr<CefPostData> post = CefPostData::Create();
  CefRefPtr<CefPostDataElement> element = CefPostDataElement::Create();
  element->SetToBytes(body.size(), body.data());
  post->AddElement(element);
  request->SetPostData(post);

  // 注意：OnRequestComplete 里需要拿到累积的响应体，因此这里用同一个对象做 client
  class Client : public CefURLRequestClient {
   public:
    Client(SidecarCallback cb) : cb_(std::move(cb)) {}
    void OnRequestComplete(CefRefPtr<CefURLRequest> req) override {
      bool ok = false;
      std::string error;
      std::string result;
      if (req->GetRequestStatus() == UR_SUCCESS) {
        const int status = req->GetResponse() ? req->GetResponse()->GetStatus() : 0;
        if (status >= 200 && status < 300) {
          result = ExtractSidecarResult(body_, ok, error);
        } else {
          // 边车的错误信封也可能带 4xx，先尝试解析
          result = ExtractSidecarResult(body_, ok, error);
          if (!ok && error.empty()) error = "边车返回 HTTP " + std::to_string(status);
        }
      } else {
        error = "无法连接边车（请确认 tib-service 已启动）";
      }
      if (cb_) cb_(ok, ok ? result : error);
    }
    void OnUploadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
    void OnDownloadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
    void OnDownloadData(CefRefPtr<CefURLRequest>, const void* data, size_t length) override {
      body_.append(static_cast<const char*>(data), length);
    }
    bool GetAuthCredentials(bool, const CefString&, int, const CefString&, const CefString&,
                            CefRefPtr<CefAuthCallback>) override {
      return false;
    }

   private:
    SidecarCallback cb_;
    std::string body_;
    IMPLEMENT_REFCOUNTING(Client);
  };

  CefRefPtr<CefURLRequestClient> client = new Client(std::move(callback));
  CefURLRequest::Create(request, client, nullptr);
}

std::string AutomationInfoJson() {  const std::string path = AppContext::Get().user_data_dir() + kAutomationFile;
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
