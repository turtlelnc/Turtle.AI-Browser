// CRX 扩展包解包（支持 CRX2 与 CRX3）。
//
// 为什么需要：Chromium 的扩展加载只接受**目录**形式，.crx 必须先解包。
// 这不是可选项 —— 用户拿到的基本都是 .crx。
//
// CRX 文件结构：
//   "Cr24" | version(4) | 头部长度(4) | 头部 | ZIP 数据
//   * CRX2 的头部长度字段只覆盖公钥+签名部分；
//   * CRX3 的头部长度字段**不含前面 12 字节固定头**，所以 ZIP 起始偏移是 12 + headerSize。
//     v0.1.0 就是在这里少加了 12，导致所有 CRX3 都报 "Invalid CEN header"。
//
// ZIP 解包：自己实现最小实现（只用 stored 与 deflate 两种压缩方式）。
// deflate 解压用 Windows 自带的 Compression API（cabinet.dll 的 RtlDecompressBuffer
// 不便使用，这里用 inflate 的 Windows 实现等价物）。
#include "crx.h"

#include <windows.h>

#include <cstring>
#include <fstream>
#include <vector>

namespace tib {
namespace {

uint32_t ReadLE32(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

uint16_t ReadLE16(const unsigned char* p) {
  return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

/** 安全拼接路径，拒绝目录穿越 */
bool SafeJoin(const std::string& base, const std::string& rel, std::string& out) {
  if (rel.empty() || rel.find("..") != std::string::npos) return false;
  if (rel[0] == '/' || rel[0] == '\\') return false;
  out = base + "\\" + rel;
  for (auto& c : out) {
    if (c == '/') c = '\\';
  }
  return true;
}

/** 递归创建目录 */
void EnsureDir(const std::string& path) {
  std::string acc;
  for (size_t i = 0; i < path.size(); ++i) {
    acc.push_back(path[i]);
    if (path[i] == '\\' || i + 1 == path.size()) {
      if (!acc.empty() && acc.back() != ':') ::CreateDirectoryA(acc.c_str(), nullptr);
    }
  }
}

/**
 * 最小 ZIP 解包器：只支持 store(0) 与 deflate(8)。
 * 这两种覆盖了实际扩展包的绝大多数情况；其余方式会明确报错，不静默跳过。
 */
bool UnzipTo(const unsigned char* zip, size_t zip_size, const std::string& out_dir,
             std::string& error) {
  // 从尾部找 End of Central Directory（0x06054b50）
  if (zip_size < 22) {
    error = "ZIP 数据过短";
    return false;
  }
  size_t eocd = std::string::npos;
  const size_t scan_start = zip_size > 66000 ? zip_size - 66000 : 0;
  for (size_t i = zip_size - 22; i + 4 <= zip_size && i >= scan_start; --i) {
    if (zip[i] == 0x50 && zip[i + 1] == 0x4b && zip[i + 2] == 0x05 && zip[i + 3] == 0x06) {
      eocd = i;
      break;
    }
    if (i == 0) break;
  }
  if (eocd == std::string::npos) {
    error = "未找到 ZIP 中央目录（文件可能损坏）";
    return false;
  }

  const uint16_t count = ReadLE16(zip + eocd + 10);
  const uint32_t cd_offset = ReadLE32(zip + eocd + 16);
  if (cd_offset >= zip_size) {
    error = "中央目录偏移越界";
    return false;
  }

  size_t p = cd_offset;
  for (uint16_t i = 0; i < count; ++i) {
    if (p + 46 > zip_size) {
      error = "中央目录条目越界";
      return false;
    }
    if (!(zip[p] == 0x50 && zip[p + 1] == 0x4b && zip[p + 2] == 0x01 && zip[p + 3] == 0x02)) {
      error = "中央目录签名不正确";
      return false;
    }
    const uint16_t method = ReadLE16(zip + p + 10);
    const uint32_t comp_size = ReadLE32(zip + p + 20);
    const uint32_t uncomp_size = ReadLE32(zip + p + 24);
    const uint16_t name_len = ReadLE16(zip + p + 28);
    const uint16_t extra_len = ReadLE16(zip + p + 30);
    const uint16_t comment_len = ReadLE16(zip + p + 32);
    const uint32_t local_offset = ReadLE32(zip + p + 42);
    const std::string name(reinterpret_cast<const char*>(zip + p + 46), name_len);
    p += 46 + name_len + extra_len + comment_len;

    if (!name.empty() && name.back() == '/') continue;  // 目录条目

    std::string out_path;
    if (!SafeJoin(out_dir, name, out_path)) {
      error = "扩展包内含非法路径：" + name;
      return false;
    }
    // 建父目录
    const size_t slash = out_path.find_last_of('\\');
    if (slash != std::string::npos) EnsureDir(out_path.substr(0, slash));

    // 定位局部头以取得真实数据偏移
    if (local_offset + 30 > zip_size) {
      error = "局部头偏移越界";
      return false;
    }
    const uint16_t lname_len = ReadLE16(zip + local_offset + 26);
    const uint16_t lextra_len = ReadLE16(zip + local_offset + 28);
    const size_t data_off = local_offset + 30 + lname_len + lextra_len;
    if (data_off + comp_size > zip_size) {
      error = "文件数据越界：" + name;
      return false;
    }

    std::vector<unsigned char> out;
    if (method == 0) {
      out.assign(zip + data_off, zip + data_off + comp_size);
    } else if (method == 8) {
      // 用 Windows 的压缩 API（Win8+）解 raw deflate
      HMODULE cab = ::LoadLibraryA("cabinet.dll");
      typedef BOOL(WINAPI * CreateFn)(USHORT, USHORT, PVOID);
      typedef BOOL(WINAPI * DecompressFn)(PVOID, PVOID, ULONG, PVOID, ULONG, PULONG);
      typedef BOOL(WINAPI * CloseFn)(PVOID);
      if (!cab) {
        error = "无法加载 cabinet.dll，无法解压 deflate 数据";
        return false;
      }
      auto pCreate = reinterpret_cast<CreateFn>(::GetProcAddress(cab, "CreateDecompressor"));
      auto pDecompress = reinterpret_cast<DecompressFn>(::GetProcAddress(cab, "Decompress"));
      auto pClose = reinterpret_cast<CloseFn>(::GetProcAddress(cab, "CloseDecompressor"));
      if (!pCreate || !pDecompress || !pClose) {
        ::FreeLibrary(cab);
        error = "系统缺少解压所需接口";
        return false;
      }
      // COMPRESS_ALGORITHM_MSZIP=2 需要 zlib 头；这里用 COMPRESS_ALGORITHM_DEFLATE=4 的 raw 模式
      const ULONG kDeflate = 4;
      PVOID dec = nullptr;
      if (!pCreate(kDeflate, 0, &dec) || !dec) {
        ::FreeLibrary(cab);
        error = "创建解压器失败";
        return false;
      }
      out.resize(uncomp_size ? uncomp_size : comp_size * 4 + 1024);
      ULONG produced = 0;
      const BOOL ok = pDecompress(dec, const_cast<unsigned char*>(zip + data_off), comp_size,
                                  out.data(), static_cast<ULONG>(out.size()), &produced);
      pClose(dec);
      ::FreeLibrary(cab);
      if (!ok) {
        error = "解压失败（" + name + "）";
        return false;
      }
      out.resize(produced);
    } else {
      error = "扩展包使用了不支持的压缩方式（" + std::to_string(method) + "）：" + name;
      return false;
    }

    std::ofstream f(out_path, std::ios::binary | std::ios::trunc);
    if (!f) {
      error = "无法写入文件：" + out_path;
      return false;
    }
    f.write(reinterpret_cast<const char*>(out.data()), static_cast<std::streamsize>(out.size()));
  }
  return true;
}

}  // namespace

bool UnpackCrx(const std::string& crx_path, const std::string& out_dir, std::string& error) {
  std::ifstream in(crx_path, std::ios::binary);
  if (!in) {
    error = "无法打开文件：" + crx_path;
    return false;
  }
  std::vector<unsigned char> data((std::istreambuf_iterator<char>(in)),
                                  std::istreambuf_iterator<char>());
  if (data.size() < 16) {
    error = "文件过小，不是有效的 CRX";
    return false;
  }
  if (!(data[0] == 'C' && data[1] == 'r' && data[2] == '2' && data[3] == '4')) {
    // 也可能用户选了个 zip（部分扩展直接以 zip 分发）
    if (data[0] == 0x50 && data[1] == 0x4b) {
      return UnzipTo(data.data(), data.size(), out_dir, error);
    }
    error = "不是 CRX 格式（缺少 Cr24 魔数）";
    return false;
  }

  const uint32_t version = ReadLE32(&data[4]);
  const uint32_t header_size = ReadLE32(&data[8]);

  // 关键：CRX3 的 header_size 不含前面 12 字节固定头；CRX2 的也不含。
  // 因此 ZIP 起始偏移统一是 12 + header_size。
  const size_t zip_offset = 12u + static_cast<size_t>(header_size);
  if (zip_offset >= data.size()) {
    error = "CRX 头部长度越界（version=" + std::to_string(version) +
            "，headerSize=" + std::to_string(header_size) + "）";
    return false;
  }
  if (!(data[zip_offset] == 0x50 && data[zip_offset + 1] == 0x4b)) {
    error = "CRX 内的 ZIP 起始位置不正确（偏移 " + std::to_string(zip_offset) + "）";
    return false;
  }

  Log("解包 CRX：版本 " + std::to_string(version) + "，头部 " + std::to_string(header_size) +
      " 字节，ZIP 起始偏移 " + std::to_string(zip_offset));
  EnsureDir(out_dir);
  return UnzipTo(data.data() + zip_offset, data.size() - zip_offset, out_dir, error);
}

}  // namespace tib
