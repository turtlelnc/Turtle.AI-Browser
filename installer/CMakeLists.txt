cmake_minimum_required(VERSION 3.21)

# TiBrowser 安装器（原生，零外部依赖）
# 单独一个工程，不依赖 CEF —— 安装器只需要 Win32 + Shell API。
project(TiBrowserSetup VERSION 1.0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

if(MSVC)
  add_compile_options(/utf-8 /W3)
  add_definitions(-DUNICODE -D_UNICODE -DNOMINMAX -DWIN32_LEAN_AND_MEAN)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()

add_executable(TiBrowserSetup WIN32
  setup.cpp
  setup.rc
)

target_link_libraries(TiBrowserSetup PRIVATE shell32 ole32 uuid)

# 安装器与 dist 目录需要放在一起分发，这里在构建后给出提示
add_custom_command(TARGET TiBrowserSetup POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E echo
    "安装器已生成。分发时请把 TiBrowserSetup.exe 与 dist\\ 目录放在同一个文件夹。"
)
