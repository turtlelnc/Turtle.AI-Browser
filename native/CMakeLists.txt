cmake_minimum_required(VERSION 3.21)

# TiBrowser 原生外壳（Chromium / CEF）
# 版本：v1.0.0-rc1 (build 260913)
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
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
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

add_subdirectory("${TIB_CEF_ROOT}/libcef_dll")

# 产品版本号：供「关于」页与窗口标题使用
set(TIB_VERSION "1.0.0-rc1")
set(TIB_BUILD "260913")
configure_file(
  "${CMAKE_CURRENT_SOURCE_DIR}/src/version.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/version.h"
  @ONLY)

add_executable(TiBrowser WIN32
  src/main.cpp
  src/app.cpp
  src/window.cpp
  src/chrome.cpp
  src/scheme.cpp
  src/router.cpp
  src/security.cpp
  src/service_client.cpp
  src/util.cpp
)

target_include_directories(TiBrowser PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  "${CMAKE_CURRENT_BINARY_DIR}/generated")

target_link_libraries(TiBrowser PRIVATE libcef_lib libcef_dll_wrapper)

# CEF 运行时文件（dll / pak / locales / swiftshader 等）复制到输出目录
COPY_FILES(TiBrowser "${TIB_CEF_ROOT}")

# UI 与内置页面资源：把 Vite 产物 dist/ui 复制到输出目录 ui/
set(TIB_UI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../dist/ui")
if(EXISTS "${TIB_UI_DIR}")
  add_custom_command(TARGET TiBrowser POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${TIB_UI_DIR}" "$<TARGET_FILE_DIR:TiBrowser>/ui"
    COMMENT "复制浏览器外壳 UI 到输出目录")
else()
  message(WARNING "未找到 ${TIB_UI_DIR}，请先运行 `npm run ui:build`。程序启动时会显示缺失提示页。")
endif()

# blocklists 资源
add_custom_command(TARGET TiBrowser POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
    "${CMAKE_CURRENT_SOURCE_DIR}/../resources"
    "$<TARGET_FILE_DIR:TiBrowser>/resources"
  COMMENT "复制黑名单等资源")
