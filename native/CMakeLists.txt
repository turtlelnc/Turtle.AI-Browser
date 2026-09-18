cmake_minimum_required(VERSION 3.21)

# TiBrowser 原生外壳（Chromium / CEF）
# 版本：v1.0.1-rc2 (build 260918)
project(TiBrowser VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# MSVC：与 CEF 官方发行包保持一致的迭代器调试级别，否则链接期会报 _ITERATOR_DEBUG_LEVEL 不匹配
if(MSVC)
  add_compile_options(/utf-8 /MP /W3 /wd4100 /wd4996)
  add_definitions(-DUNICODE -D_UNICODE -DNOMINMAX -DWIN32_LEAN_AND_MEAN)
  # CEF 发行包的 libcef_dll_wrapper 是用 /MT（静态 CRT）编译的，必须一致，否则 LNK2038
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
  add_link_options(/DEBUG:FASTLINK)
endif()

# ---- CEF 位置：优先环境变量 TIB_CEF_ROOT，其次 third_party/cef，再其次 .cef-cache/cmake ----
set(TIB_CEF_ROOT "$ENV{TIB_CEF_ROOT}" CACHE PATH "CEF 发行包根目录（含 cmake/ 与 libcef_dll/）")
if(NOT TIB_CEF_ROOT OR NOT EXISTS "${TIB_CEF_ROOT}/cmake")
  foreach(candidate
      "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/cef"
      "${CMAKE_CURRENT_SOURCE_DIR}/../.cef-cache/cmake")
    if(EXISTS "${candidate}/cmake")
      set(TIB_CEF_ROOT "${candidate}")
      break()
    endif()
  endforeach()
endif()

if(NOT TIB_CEF_ROOT OR NOT EXISTS "${TIB_CEF_ROOT}/cmake")
  message(FATAL_ERROR
    "未找到 CEF 发行包。请先执行 `npm run fetch:cef`（脚本会下载并解压到 .cef-cache/cmake），"
    "或用 -DTIB_CEF_ROOT=<路径> 指定。")
endif()
message(STATUS "使用 CEF: ${TIB_CEF_ROOT}")

set(CEF_ROOT "${TIB_CEF_ROOT}" CACHE PATH "" FORCE)
list(APPEND CMAKE_MODULE_PATH "${TIB_CEF_ROOT}/cmake")
find_package(CEF REQUIRED)

# CEF 的 wrapper 目标在源码树之外，必须显式给出二进制目录
add_subdirectory("${TIB_CEF_ROOT}/libcef_dll" "${CMAKE_CURRENT_BINARY_DIR}/libcef_dll")

# 产品版本号：供「关于」页与窗口标题使用
set(TIB_VERSION "1.0.1-rc2")
set(TIB_BUILD "260918")
configure_file(
  "${CMAKE_CURRENT_SOURCE_DIR}/src/version.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/version.h"
  @ONLY)

add_executable(TiBrowser WIN32
  src/main.cpp
  src/app.cpp
  src/window.cpp
  src/scheme.cpp
  src/router.cpp
  src/security.cpp
  src/service_client.cpp
  src/util.cpp
  src/local_server.cpp
  src/store.cpp
  src/api.cpp
  src/crx.cpp
  resources/tibrowser.rc   # 图标（来自根目录 ico.png）与版本信息
)

# 资源编译器需要能找到 icon.ico：把 build/ 作为资源搜索目录
set(CMAKE_RC_FLAGS "${CMAKE_RC_FLAGS} /I \"${CMAKE_CURRENT_SOURCE_DIR}/../build\"")
target_include_directories(TiBrowser PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../build")

target_include_directories(TiBrowser PRIVATE
  "${TIB_CEF_ROOT}"  # 让 #include "include/cef_*.h" 生效（CEF 官方示例的写法）
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  "${CMAKE_CURRENT_BINARY_DIR}/generated")

# 链接：libcef_dll_wrapper（CEF 的 C++ 包装层）+ libcef.lib（Chromium 内核导入库）
if(WIN32)
  target_link_libraries(TiBrowser PRIVATE libcef_dll_wrapper "${CEF_LIB_RELEASE}")
  # 延迟加载：允许在没有 libcef.dll 的机器上给出可读错误而不是直接无法启动
  target_link_options(TiBrowser PRIVATE "/DELAYLOAD:libcef.dll")
  target_link_libraries(TiBrowser PRIVATE delayimp)
else()
  target_link_libraries(TiBrowser PRIVATE libcef_dll_wrapper "${CEF_LIB_RELEASE}")
endif()

# CEF 运行时文件（libcef.dll / pak / locales / swiftshader 等）复制到输出目录
# Windows 下发行包的运行库在 Release/，资源在 Resources/
COPY_FILES(TiBrowser "${CEF_BINARY_FILES}" "${TIB_CEF_ROOT}/Release"
  "$<TARGET_FILE_DIR:TiBrowser>")
COPY_FILES(TiBrowser "${CEF_RESOURCE_FILES}" "${TIB_CEF_ROOT}/Resources"
  "$<TARGET_FILE_DIR:TiBrowser>")

# 启动诊断探针：最小 CEF 程序，用于把「内核能否起来」与「外壳代码」分离定位
add_executable(TiBrowserProbe WIN32 probe/probe.cpp)
target_include_directories(TiBrowserProbe PRIVATE "${TIB_CEF_ROOT}")
target_link_libraries(TiBrowserProbe PRIVATE libcef_dll_wrapper "${CEF_LIB_RELEASE}")
if(WIN32)
  target_link_options(TiBrowserProbe PRIVATE "/DELAYLOAD:libcef.dll")
  target_link_libraries(TiBrowserProbe PRIVATE delayimp)
endif()
COPY_FILES(TiBrowserProbe "${CEF_BINARY_FILES}" "${TIB_CEF_ROOT}/Release"
  "$<TARGET_FILE_DIR:TiBrowserProbe>")
COPY_FILES(TiBrowserProbe "${CEF_RESOURCE_FILES}" "${TIB_CEF_ROOT}/Resources"
  "$<TARGET_FILE_DIR:TiBrowserProbe>")

# UI 与内置页面资源：把 Vite 产物 dist/ui 复制到输出目录 ui/
set(TIB_UI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../dist/ui")
if(EXISTS "${TIB_UI_DIR}")
  add_custom_command(TARGET TiBrowser POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${TIB_UI_DIR}" "$<TARGET_FILE_DIR:TiBrowser>/ui"
    COMMENT "复制浏览器外壳 UI 到输出目录")
else()
  message(WARNING "未找到 ${TIB_UI_DIR}，请先运行 `npm run ui:build`。程序启动时会显示缺失提示页。")
endif()

# 边车：把已构建的 Node 服务复制到输出目录 service/
# 边车是 AI / MCP / OAuth / 办公与开发模式的承载者。未构建时浏览器仍可正常使用，
# 只是 AI 能力降级（界面上会明确提示"边车未运行"，不会假装可用）。
set(TIB_SERVICE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../service")
if(EXISTS "${TIB_SERVICE_DIR}/dist/index.js")
  add_custom_command(TARGET TiBrowser POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${TIB_SERVICE_DIR}/dist"
            "$<TARGET_FILE_DIR:TiBrowser>/service"
    COMMENT "复制边车服务到输出目录")
  if(EXISTS "${TIB_SERVICE_DIR}/node_modules")
    add_custom_command(TARGET TiBrowser POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_directory "${TIB_SERVICE_DIR}/node_modules"
              "$<TARGET_FILE_DIR:TiBrowser>/service/node_modules"
      COMMENT "复制边车依赖到输出目录")
  endif()
else()
  message(WARNING "未找到 service/dist/index.js，请先运行 `npm run service:build`。AI 能力将不可用。")
endif()

# blocklists 资源
add_custom_command(TARGET TiBrowser POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
    "${CMAKE_CURRENT_SOURCE_DIR}/../resources"
    "$<TARGET_FILE_DIR:TiBrowser>/resources"
  COMMENT "复制黑名单等资源")
