; resources/installer.nsh — NSIS 自定义脚本
;
; 大模块组件化（画板/白板，约 140 MB）：
;   - customWelcomePage：欢迎页后插入组件页，勾选是否安装画板组件
;   - 文件复制由安装主段完成；未勾选时 customInstall 删除组件目录并写入清单
;   - plugins-manifest.json 写入安装目录（主进程 module-state-store 读取）
;   - 更新安装时跳过组件页（skipPageIfUpdated），以既有清单为准保持选择
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

; ===== 大模块组件：画板/白板（默认勾选；仅用于记录勾选状态，文件由主段复制） =====
; 主功能（AI 应用聚合、设置、提示词、历史等）始终安装，无法取消。
; 仅大模块（>10MB）可选，其余小模块在应用内「模块管理」中开关。
Section /o "画板/白板（约 140 MB，可选）" SEC_WHITEBOARD
  DetailPrint "安装画板/白板功能（Excalidraw 白板）"
SectionEnd

; ===== 组件页：欢迎页之后展示；更新安装时跳过（保持既有选择） =====
; MUI_COMPONENTSPAGE_TEXT_TOP 控制组件页顶部说明文字
!define MUI_COMPONENTSPAGE_TEXT_TOP "Main features always installed. Optional large modules below."
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_COMPONENTS
!macroend

; ===== 安装段收尾：按勾选状态删除/保留组件 + 写入安装清单 =====
!macro customInstall
  ; 既有选择（更新安装保持）：读取上次写入的清单
  StrCpy $R7 ""
  ${If} ${FileExists} "$INSTDIR\plugins-manifest.json"
    FileOpen $0 "$INSTDIR\plugins-manifest.json" r
    FileRead $0 $1
    FileClose $0
    ${StrContains} $R7 $1 "installed$\":false"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SEC_WHITEBOARD}
  ${AndIf} $R7 == ""
    ; 安装白板组件：写入 installed:true
    FileOpen $0 "$INSTDIR\plugins-manifest.json" w
    FileWrite $0 '{"whiteboard":{"installed":true}}$\r$\n'
    FileClose $0
  ${Else}
    ; 未勾选/曾卸载：删除组件目录（节省磁盘），写入 installed:false
    RMDir /r "$INSTDIR\resources\plugins\whiteboard"
    FileOpen $0 "$INSTDIR\plugins-manifest.json" w
    FileWrite $0 '{"whiteboard":{"installed":false}}$\r$\n'
    FileClose $0
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

