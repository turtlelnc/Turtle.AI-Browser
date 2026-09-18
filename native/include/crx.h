// CRX 扩展包解包（CRX2 / CRX3）。
#pragma once

#include "tib_common.h"

namespace tib {

/**
 * 把 .crx（或直接以 zip 分发的扩展包）解包到 out_dir。
 * @return 成功返回 true；失败时 error 是中文原因。
 */
bool UnpackCrx(const std::string& crx_path, const std::string& out_dir, std::string& error);

}  // namespace tib
