# Windows 私有运行库

安装包包含 Python、PDF 引擎及其所需的 Visual C++ x64 运行库。用户无需安装 Python、Visual Studio 或单独安装系统级 Visual C++ Redistributable；WebView2 的安装行为仍由 NSIS 管理。

## 构建输入

`scripts/runtime-manifest.json` 固定 Python 归档及 Visual C++ 运行库的版本与 SHA-256。后者来自已安装的 Visual Studio 2022 Build Tools：

```text
VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT
```

此目录内的 DLL 文件版本为 `14.44.35211.0`，目录号与文件版本号不同。准备脚本通过 `vswhere` 查找目录，也可将 `PDF_SEARCH_VC_REDIST_DIR` 指向该版本的 `Microsoft.VC143.CRT`。只接受清单内精确校验值；缺失或版本不符会停止构建。升级时从微软 Visual Studio 分发目录核对数字签名、版本和哈希后更新清单，不使用系统目录或第三方 DLL 下载站。

脚本将完整 CRT 文件组复制到私有 `python.exe` 同目录，不写系统目录、不运行系统级安装器。原始文件保持不变；包内附来源和许可说明 `MSVC_RUNTIME_NOTICE.txt`。分发范围依据[微软 Visual C++ 分发清单](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution#visual-c-runtime-files)。

## 验证

`scripts/prepare-runtime.ps1` 在安装锁定依赖后强制执行原生依赖审计和引擎健康检查。运行时生成后，会先清除 Python 发行包和安装工具自带的 `.pyc`，再只为 PyMuPDF 的 `pymupdf`、`fitz` 源码生成 checked-hash 缓存。缓存的 `co_filename` 使用包内相对路径，不写入构建机或安装目录的绝对路径；源码仍完整保留。引擎用 `-B` 启动时不会写新缓存，但会读取并校验这些预编译缓存。

手动核对：

```powershell
.build/runtime/python/python.exe -B -I scripts/audit-runtime-native.py --runtime .build/runtime/python --verify-loaded
.build/runtime/python/python.exe -B -I scripts/prepare-pymupdf-bytecode.py --python-root .build/runtime/python --verify-only --strict-cache-set
.build/runtime/python/python.exe -B -I -X utf8 scripts/smoke-runtime.py --resource-root .
```

第一项扫描 PE 的导入表（含延迟导入），拒绝缺少的包内 CRT；启动私有 Python 导入 PyMuPDF 后，确认实际加载的 CRT 来自私有目录。第二项检查 PyMuPDF 缓存完整、与当前源码哈希匹配、缓存标记为 checked-hash，且缓存代码文件名不含绝对路径。第三项用合成 PDF 验证搜索、预览和裁剪导出。

0.1.33 曾遗漏 PyMuPDF 所需的 `MSVCP140.dll`，开发机从 System32 加载同名 DLL 掩盖了问题。仅通过引擎健康检查或本机 PDF 冒烟不足以证明干净系统可用，仍需用最终安装包在干净 Windows 10/11 x64 执行 M05。
