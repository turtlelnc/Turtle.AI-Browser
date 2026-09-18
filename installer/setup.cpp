// TiBrowser 安装器（原生，无外部依赖）。
//
// 为什么自己写：本机没有 NSIS / Inno Setup / 7-Zip，winget 装包会卡在网络上，
// 而 CEF 发行包里也没有可用的打包工具。与其交付一个"只有免安装目录"的 rc，
// 不如用已有的 MSVC 工具链写一个够用的安装器 —— 依赖为零，行为完全可控。
//
// 它能做：
//   * 把随包的 payload（与安装器同目录的 dist/ 或内嵌清单里的文件）复制到目标目录
//   * 创建开始菜单与桌面快捷方式（.lnk，用 IShellLink，不依赖第三方库）
//   * 写入卸载信息到注册表（HKCU，无需管理员），并提供卸载入口
//   * 记录安装清单，卸载时按清单删除，不误删用户数据
//
// 它**不做**（如实说明，README 里也写了）：
//   * 代码签名（无证书）
//   * 驱动级/系统级安装（只装到用户目录，不需要管理员）
//   * 自动更新
//
// 用法：
//   TiBrowserSetup.exe                 交互式安装
//   TiBrowserSetup.exe --silent        静默安装到默认目录
//   TiBrowserSetup.exe --dir=<路径>    指定安装目录
//   TiBrowserSetup.exe --uninstall     执行卸载（由卸载快捷方式调用）
#include <windows.h>

#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <string>
#include <vector>

#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")

namespace {

constexpr wchar_t kAppName[] = L"TiBrowser";
constexpr wchar_t kVersion[] = L"1.0.1-rc2";
constexpr wchar_t kBuild[] = L"260918";
constexpr wchar_t kUninstallKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TiBrowser";
constexpr wchar_t kPayloadDir[] = L"dist";

/** 静默卸载标志（--uninstall --silent）：不弹完成提示，供脚本与自动化验证使用 */
bool silent_uninstall = false;

std::wstring ExeDir() {
  wchar_t buffer[MAX_PATH] = {0};
  const DWORD len = ::GetModuleFileNameW(nullptr, buffer, MAX_PATH);
  std::wstring path(buffer, len);
  const size_t pos = path.find_last_of(L"\\/");
  return pos == std::wstring::npos ? L"." : path.substr(0, pos);
}

/** 默认安装目录：%LOCALAPPDATA%\Programs\TiBrowser（用户级，不需要管理员） */
std::wstring DefaultInstallDir() {
  wchar_t* local = nullptr;
  std::wstring result = ExeDir() + L"\\TiBrowser";
  if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local))) {
    result = std::wstring(local) + L"\\Programs\\TiBrowser";
    ::CoTaskMemFree(local);
  }
  return result;
}

bool EnsureDir(const std::wstring& dir) {
  const int r = ::SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
  return r == ERROR_SUCCESS || r == ERROR_ALREADY_EXISTS || r == ERROR_FILE_EXISTS;
}

/** 递归复制目录，并把相对路径收集进清单（供卸载使用） */
bool CopyTree(const std::wstring& from, const std::wstring& to,
              const std::wstring& rel, std::vector<std::wstring>& manifest,
              std::wstring& error) {
  WIN32_FIND_DATAW fd{};
  const std::wstring pattern = from + L"\\*";
  HANDLE h = ::FindFirstFileW(pattern.c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) {
    error = L"无法读取目录：" + from;
    return false;
  }
  do {
    const std::wstring name = fd.cFileName;
    if (name == L"." || name == L"..") continue;
    const std::wstring src = from + L"\\" + name;
    const std::wstring relChild = rel.empty() ? name : rel + L"\\" + name;
    const std::wstring dst = to + L"\\" + relChild;
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      if (!EnsureDir(dst)) {
        error = L"无法创建目录：" + dst;
        ::FindClose(h);
        return false;
      }
      if (!CopyTree(src, to, relChild, manifest, error)) {
        ::FindClose(h);
        return false;
      }
    } else {
      if (!::CopyFileW(src.c_str(), dst.c_str(), FALSE)) {
        error = L"复制失败：" + name + L"（错误码 " + std::to_wstring(::GetLastError()) + L"）";
        ::FindClose(h);
        return false;
      }
      manifest.push_back(relChild);
    }
  } while (::FindNextFileW(h, &fd));
  ::FindClose(h);
  return true;
}

/** 创建 .lnk 快捷方式 */
bool CreateShortcut(const std::wstring& link_path, const std::wstring& target,
                    const std::wstring& workdir, const std::wstring& args,
                    const std::wstring& description) {
  IShellLinkW* link = nullptr;
  if (FAILED(::CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                                IID_IShellLinkW, reinterpret_cast<void**>(&link)))) {
    return false;
  }
  link->SetPath(target.c_str());
  link->SetWorkingDirectory(workdir.c_str());
  if (!args.empty()) link->SetArguments(args.c_str());
  if (!description.empty()) link->SetDescription(description.c_str());

  IPersistFile* file = nullptr;
  bool ok = false;
  if (SUCCEEDED(link->QueryInterface(IID_IPersistFile, reinterpret_cast<void**>(&file)))) {
    ok = SUCCEEDED(file->Save(link_path.c_str(), TRUE));
    file->Release();
  }
  link->Release();
  return ok;
}

std::wstring StartMenuDir() {
  wchar_t* p = nullptr;
  std::wstring result;
  if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_Programs, 0, nullptr, &p))) {
    result = p;
    ::CoTaskMemFree(p);
  }
  return result;
}

std::wstring DesktopDir() {
  wchar_t* p = nullptr;
  std::wstring result;
  if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_Desktop, 0, nullptr, &p))) {
    result = p;
    ::CoTaskMemFree(p);
  }
  return result;
}

void WriteString(HKEY key, const wchar_t* name, const std::wstring& value) {
  ::RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
                   static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
}

void WriteDword(HKEY key, const wchar_t* name, DWORD value) {
  ::RegSetValueExW(key, name, 0, REG_DWORD, reinterpret_cast<const BYTE*>(&value), sizeof(value));
}

/** 写卸载信息（HKCU，无需管理员） */
bool WriteUninstallEntry(const std::wstring& install_dir, const std::wstring& uninstaller,
                         DWORD payload_bytes) {
  HKEY key = nullptr;
  if (::RegCreateKeyExW(HKEY_CURRENT_USER, kUninstallKey, 0, nullptr, 0, KEY_WRITE, nullptr, &key,
                        nullptr) != ERROR_SUCCESS) {
    return false;
  }
  WriteString(key, L"DisplayName", kAppName);
  WriteString(key, L"DisplayVersion", std::wstring(kVersion) + L" (build " + kBuild + L")");
  WriteString(key, L"Publisher", L"turtlelnc");
  WriteString(key, L"InstallLocation", install_dir);
  WriteString(key, L"UninstallString", L"\"" + uninstaller + L"\" --uninstall");
  WriteString(key, L"DisplayIcon", install_dir + L"\\TiBrowser.exe");
  WriteString(key, L"URLInfoAbout", L"https://github.com/turtlelnc/Turtle.AI-Browser");
  WriteDword(key, L"EstimatedSize", payload_bytes / 1024);
  WriteDword(key, L"NoModify", 1);
  WriteDword(key, L"NoRepair", 1);
  ::RegCloseKey(key);
  return true;
}

DWORD DirSize(const std::wstring& dir) {
  DWORD total = 0;
  WIN32_FIND_DATAW fd{};
  HANDLE h = ::FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return 0;
  do {
    const std::wstring name = fd.cFileName;
    if (name == L"." || name == L"..") continue;
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      total += DirSize(dir + L"\\" + name);
    } else {
      total += fd.nFileSizeLow;
    }
  } while (::FindNextFileW(h, &fd));
  ::FindClose(h);
  return total;
}

/** 递归删除目录，逐级向上清理空目录。
 *  只删**空目录**（RemoveDirectory 本身要求空），因此不会误删用户放进去的文件。 */
void RemoveEmptyTree(const std::wstring& dir) {
  WIN32_FIND_DATAW fd{};
  HANDLE h = ::FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      const std::wstring name = fd.cFileName;
      if (name == L"." || name == L"..") continue;
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        RemoveEmptyTree(dir + L"\\" + name);
      }
    } while (::FindNextFileW(h, &fd));
    ::FindClose(h);
  }
  ::RemoveDirectoryW(dir.c_str());
}

/** 卸载：按清单删除文件与目录，并清理快捷方式与注册表 */
int Uninstall(const std::wstring& install_dir) {
  const std::wstring manifest = install_dir + L"\\install-manifest.txt";
  std::vector<std::wstring> files;
  {
    HANDLE f = ::CreateFileW(manifest.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                             OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f != INVALID_HANDLE_VALUE) {
      std::string content;
      char buf[8192];
      DWORD read = 0;
      while (::ReadFile(f, buf, sizeof(buf), &read, nullptr) && read > 0) {
        content.append(buf, read);
      }
      ::CloseHandle(f);
      size_t start = 0;
      while (start < content.size()) {
        size_t end = content.find('\n', start);
        if (end == std::string::npos) end = content.size();
        std::string line = content.substr(start, end - start);
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        if (!line.empty()) {
          const int wlen = ::MultiByteToWideChar(CP_UTF8, 0, line.c_str(), -1, nullptr, 0);
          std::wstring w(wlen > 0 ? wlen - 1 : 0, L'\0');
          if (wlen > 1) ::MultiByteToWideChar(CP_UTF8, 0, line.c_str(), -1, w.data(), wlen);
          files.push_back(w);
        }
        start = end + 1;
      }
    }
  }

  // 先删文件（倒序：长路径优先，保证随后能清理空目录）
  int deleted = 0;
  for (auto it = files.rbegin(); it != files.rend(); ++it) {
    if (::DeleteFileW((install_dir + L"\\" + *it).c_str())) ++deleted;
  }
  ::DeleteFileW(manifest.c_str());
  // 运行期生成的文件（日志等）不在清单里，单独清掉，避免卸载后留垃圾
  ::DeleteFileW((install_dir + L"\\tibrowser-startup.log").c_str());
  ::DeleteFileW((install_dir + L"\\tibrowser.log").c_str());
  ::DeleteFileW((install_dir + L"\\tibrowser-crash.log").c_str());
  ::DeleteFileW((install_dir + L"\\cef.log").c_str());
  // 再递归清理空目录（含 locales/ service/ ui/ 等层级）
  RemoveEmptyTree(install_dir);

  // 快捷方式与注册表
  ::DeleteFileW((StartMenuDir() + L"\\" + kAppName + L".lnk").c_str());
  ::DeleteFileW((StartMenuDir() + L"\\卸载 " + kAppName + L".lnk").c_str());
  ::DeleteFileW((DesktopDir() + L"\\" + kAppName + L".lnk").c_str());
  ::RegDeleteTreeW(HKEY_CURRENT_USER, kUninstallKey);

  const bool dir_gone = ::GetFileAttributesW(install_dir.c_str()) == INVALID_FILE_ATTRIBUTES;
  std::wstring msg = L"TiBrowser 已卸载。\n\n";
  msg += L"已删除 " + std::to_wstring(deleted) + L" 个文件。\n";
  if (!dir_gone) {
    msg += L"注意：安装目录中还有未能删除的内容（可能被占用或不是本程序安装的），\n"
           L"位置：" + install_dir + L"\n\n";
  }
  msg += L"你的浏览数据（书签、历史、设置）保留在\n%LOCALAPPDATA%\\TiBrowser，\n"
         L"如需彻底清除请手动删除该目录。";
  if (silent_uninstall) {
    return 0;  // 静默卸载不弹窗（供自动化验证与脚本调用）
  }
  ::MessageBoxW(nullptr, msg.c_str(), L"TiBrowser 卸载完成", MB_ICONINFORMATION | MB_OK);
  return 0;
}

/** 从命令行取 --dir= / --silent / --uninstall */
std::wstring GetArgValue(const std::wstring& cmdline, const std::wstring& key) {
  const size_t pos = cmdline.find(key);
  if (pos == std::wstring::npos) return L"";
  size_t start = pos + key.size();
  if (start < cmdline.size() && cmdline[start] == L'=') ++start;
  if (start < cmdline.size() && cmdline[start] == L'"') ++start;
  size_t end = start;
  while (end < cmdline.size() && cmdline[end] != L'"' && cmdline[end] != L' ') ++end;
  return cmdline.substr(start, end - start);
}

}  // namespace

int APIENTRY wWinMain(HINSTANCE, HINSTANCE, LPWSTR, int) {
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const std::wstring cmdline = ::GetCommandLineW();

  const std::wstring exe_dir = ExeDir();
  const std::wstring payload = exe_dir + L"\\" + kPayloadDir;

  // ---- 卸载路径 ----
  if (cmdline.find(L"--uninstall") != std::wstring::npos) {
    silent_uninstall = cmdline.find(L"--silent") != std::wstring::npos;
    const std::wstring dir = GetArgValue(cmdline, L"--dir");
    return Uninstall(dir.empty() ? DefaultInstallDir() : dir);
  }

  const bool silent = cmdline.find(L"--silent") != std::wstring::npos;
  std::wstring install_dir = GetArgValue(cmdline, L"--dir");
  if (install_dir.empty()) install_dir = DefaultInstallDir();

  // ---- 前置检查：payload 必须在 ----
  if (::GetFileAttributesW(payload.c_str()) == INVALID_FILE_ATTRIBUTES) {
    ::MessageBoxW(nullptr,
                  (L"未找到程序文件目录：\n" + payload +
                   L"\n\n请把安装器与 dist 目录放在同一个文件夹里再运行。")
                      .c_str(),
                  kAppName, MB_ICONERROR | MB_OK);
    return 2;
  }

  if (!silent) {
    const std::wstring msg = std::wstring(L"将安装 ") + kAppName + L" " + kVersion +
                             L" (build " + kBuild + L")\n\n安装位置：\n" + install_dir +
                             L"\n\n安装到用户目录，不需要管理员权限。是否继续？";
    if (::MessageBoxW(nullptr, msg.c_str(), kAppName,
                      MB_ICONQUESTION | MB_YESNO) != IDYES) {
      return 1;
    }
  }

  if (!EnsureDir(install_dir)) {
    ::MessageBoxW(nullptr, L"无法创建安装目录。", kAppName, MB_ICONERROR | MB_OK);
    return 3;
  }

  // ---- 复制文件 ----
  std::vector<std::wstring> manifest;
  std::wstring error;
  if (!CopyTree(payload, install_dir, L"", manifest, error)) {
    ::MessageBoxW(nullptr, (L"安装失败：\n" + error).c_str(), kAppName, MB_ICONERROR | MB_OK);
    return 4;
  }

  // ---- 写安装清单（卸载靠它，避免误删用户数据） ----
  {
    std::string out;
    for (const auto& f : manifest) {
      const int len = ::WideCharToMultiByte(CP_UTF8, 0, f.c_str(), -1, nullptr, 0, nullptr, nullptr);
      std::string utf8(len > 0 ? len - 1 : 0, '\0');
      if (len > 1) ::WideCharToMultiByte(CP_UTF8, 0, f.c_str(), -1, utf8.data(), len, nullptr, nullptr);
      out += utf8;
      out += "\r\n";
    }
    HANDLE f = ::CreateFileW((install_dir + L"\\install-manifest.txt").c_str(), GENERIC_WRITE, 0,
                             nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f != INVALID_HANDLE_VALUE) {
      DWORD written = 0;
      ::WriteFile(f, out.data(), static_cast<DWORD>(out.size()), &written, nullptr);
      ::CloseHandle(f);
    }
  }

  const std::wstring target = install_dir + L"\\TiBrowser.exe";
  const std::wstring self = exe_dir + L"\\TiBrowserSetup.exe";

  // ---- 快捷方式 ----
  const std::wstring menu = StartMenuDir();
  if (!menu.empty()) {
    EnsureDir(menu);
    CreateShortcut(menu + L"\\" + kAppName + L".lnk", target, install_dir, L"",
                   L"TiBrowser —— 基于 Chromium 内核的 AI 安全浏览器");
    CreateShortcut(menu + L"\\卸载 " + kAppName + L".lnk", self, exe_dir,
                   L"--uninstall --dir=\"" + install_dir + L"\"", L"卸载 TiBrowser");
  }
  const std::wstring desktop = DesktopDir();
  if (!desktop.empty()) {
    CreateShortcut(desktop + L"\\" + kAppName + L".lnk", target, install_dir, L"",
                   L"TiBrowser —— 基于 Chromium 内核的 AI 安全浏览器");
  }

  // ---- 注册表卸载信息 ----
  WriteUninstallEntry(install_dir, self, DirSize(install_dir));

  if (!silent) {
    const std::wstring done = std::wstring(L"安装完成。\n\n版本：") + kVersion + L" (build " +
                              kBuild + L")\n位置：" + install_dir +
                              L"\n\n已创建开始菜单与桌面快捷方式。是否立即启动？";
    if (::MessageBoxW(nullptr, done.c_str(), kAppName, MB_ICONINFORMATION | MB_YESNO) == IDYES) {
      ::ShellExecuteW(nullptr, L"open", target.c_str(), nullptr, install_dir.c_str(), SW_SHOWNORMAL);
    }
  }

  ::CoUninitialize();
  return 0;
}
