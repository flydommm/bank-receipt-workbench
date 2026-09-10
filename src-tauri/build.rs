fn main() {
    // 生成 Tauri 所需的 Windows 资源和应用清单。
    // 该清单会启用 Common Controls 6，保证 rfd 原生对话框可解析
    // TaskDialogIndirect 等现代 Windows API。
    tauri_build::build();
}
