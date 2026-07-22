; resources/installer.nsh — NSIS 自定义脚本
;
; 由 electron-builder 通过 `nsis.include` 注入到默认 NSIS 安装脚本顶部。
; 该文件需放在 buildResources 目录（resources/）下，配置中写 `include: installer.nsh`。
;
; electron-builder 的默认 .onInit 函数内会调用 `customInit` 宏（如果定义），
; 因此我们用 `!macro customInit ... !macroend` 注入架构检测逻辑。
;
; 关键变量说明：
;   - APP_ARM64：仅 arm64 安装包由 electron-builder 注入定义（x64 包不定义）
;     注意：APP_ARM64_NAME 仅在 web 下载模式下定义，嵌入式包用 APP_ARM64
;   - PROCESSOR_ARCHITECTURE  ：当前进程架构（32 位进程在 x64 系统上返回 x86）
;   - PROCESSOR_ARCHITEW6432  ：真实系统架构（32 位进程在 64 位系统上返回 AMD64/ARM64）
;     在 ARM64 Windows 上，PROCESSOR_ARCHITEW6432 = ARM64

!macro customInit
  ; ===== 架构检测：防止 arm64 安装包运行在 x64/x86 系统上 =====
  ; 用户错下 arm64 包时，安装器本身（x86 NSIS）能启动，但安装完成后
  ; SidekickAI.exe（arm64）无法在 x64 系统运行 → 启动白屏/只有卸载器。
  ; LogicLib（${If}）由 electron-builder 的 common.nsh 默认包含
  !ifdef APP_ARM64
    ; 优先读 PROCESSOR_ARCHITEW6432（32 位进程在 64 位系统上的真实架构）
    ReadEnvStr $0 "PROCESSOR_ARCHITEW6432"
    ${If} $0 == ""
      ; 变量为空（64 位进程或老系统），回退读 PROCESSOR_ARCHITECTURE
      ReadEnvStr $0 "PROCESSOR_ARCHITECTURE"
    ${EndIf}
    ${If} $0 != "ARM64"
      MessageBox MB_OK|MB_ICONSTOP \
        "此安装包为 ARM64 架构，无法在当前系统上运行。$\n$\n请下载 x64 版本的安装包。"
      Quit
    ${EndIf}
  !endif

  ; ===== 进程冲突检测：安装前关闭正在运行的 SidekickAI =====
  ; 避免文件被占用导致安装失败（NSIS 写入 exe/dll 时被占用会报错）
  ; 用 tasklist + find 检测 SidekickAI.exe，find 命中返回 0，未命中返回 1
  nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq SidekickAI.exe" /NH | find "SidekickAI.exe" >nul 2>nul && exit /b 0 || exit /b 1'
  Pop $0
  ${If} $0 == 0
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "检测到 SidekickAI 正在运行，需要先关闭才能继续安装。$\n$\n是否现在关闭？" \
      IDYES close_app IDNO abort_install
    close_app:
      nsExec::Exec 'taskkill /F /IM SidekickAI.exe'
      ; 等待 2 秒让进程完全退出，释放文件锁
      Sleep 2000
      Goto done
    abort_install:
      Quit
    done:
  ${EndIf}
!macroend

; 卸载前同样检测并关闭 SidekickAI 进程
!macro customUnInstall
  nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq SidekickAI.exe" /NH | find "SidekickAI.exe" >nul 2>nul && exit /b 0 || exit /b 1'
  Pop $0
  ${If} $0 == 0
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "检测到 SidekickAI 正在运行，需要先关闭才能完成卸载。$\n$\n是否现在关闭？" \
      IDYES close_app_un IDNO done_un
    close_app_un:
      nsExec::Exec 'taskkill /F /IM SidekickAI.exe'
      Sleep 2000
    done_un:
  ${EndIf}
!macroend
