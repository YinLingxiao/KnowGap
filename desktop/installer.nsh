; ---------- 数据文件夹：安装时选择，默认 D 盘，和安装目录分开 ----------
; 选定的路径写进 %APPDATA%\knowgap-desktop\data-location.txt（UTF-16LE），应用启动时读取，并把旧位置的数据搬过去。
; 升级安装（--updated、静默）不显示这一页，也不改指针，沿用上次选的位置。

!include nsDialogs.nsh
!include LogicLib.nsh

!define KG_POINTER_DIR "$APPDATA\knowgap-desktop"
!define KG_POINTER "$APPDATA\knowgap-desktop\data-location.txt"
!define KG_DATA_NAME "KnowGap Data"

; 指针按当前用户存：所有用户安装时临时切到当前用户的 AppData
!macro kgUserContext
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
!macroend

!macro kgRestoreContext
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

!ifndef BUILD_UNINSTALLER
  Var kgDataDir
  Var kgDataInput

  !macro customPageAfterChangeDir
    Page custom kgDataPage kgDataPageLeave

    ; 读上次安装留下的指针 → $kgDataDir（没有则为空）
    Function kgReadPointer
      StrCpy $kgDataDir ""
      !insertmacro kgUserContext
      ClearErrors
      FileOpen $0 "${KG_POINTER}" r
      ${ifNot} ${Errors}
        FileReadWord $0 $1
        ${if} $1 == 65279
          FileReadUTF16LE $0 $kgDataDir
        ${endif}
        FileClose $0
      ${endif}
      !insertmacro kgRestoreContext
    FunctionEnd

    ; 实际安装目录 → $R9（与 instFilesPre 相同：不含应用名时会补上一级应用名文件夹）
    Function kgEffectiveInstDir
      ${StrContains} $R9 "${APP_FILENAME}" $INSTDIR
      ${if} $R9 == ""
        StrCpy $R9 "$INSTDIR\${APP_FILENAME}"
      ${else}
        StrCpy $R9 $INSTDIR
      ${endif}
    FunctionEnd

    Function kgDataPage
      ${if} ${isUpdated}
        Abort
      ${endif}
      ${if} $kgDataDir == ""
        Call kgReadPointer
      ${endif}
      ${if} $kgDataDir == ""
        ; 有固定磁盘 D: 就默认放 D 盘，否则留在系统默认位置
        System::Call 'kernel32::GetDriveType(t "D:\") i .r0'
        ${if} $0 == 3
          StrCpy $kgDataDir "D:\${KG_DATA_NAME}"
        ${else}
          !insertmacro kgUserContext
          StrCpy $kgDataDir "${KG_POINTER_DIR}"
          !insertmacro kgRestoreContext
        ${endif}
      ${endif}
      !insertmacro MUI_HEADER_TEXT "选择数据文件夹" "对话、资料、学习记忆和模型配置会保存在这里"
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateLabel} 0 0 100% 36u "KnowGap 的学习数据单独存放在这个文件夹，和安装目录分开：升级、重装软件都不会动到它。$\r$\n以前保存在 C 盘的数据，会在第一次启动时自动搬过来。"
      Pop $0
      ${NSD_CreateText} 0 44u 76% 13u "$kgDataDir"
      Pop $kgDataInput
      ${NSD_CreateBrowseButton} 78% 43u 22% 15u "浏览…"
      Pop $0
      ${NSD_OnClick} $0 kgBrowse
      ${NSD_CreateLabel} 0 66u 100% 30u "建议放在 D 盘等非系统盘。选择一个已有内容的文件夹时，会在里面新建「${KG_DATA_NAME}」子文件夹存放数据。"
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function kgBrowse
      ${NSD_GetText} $kgDataInput $0
      nsDialogs::SelectFolderDialog "选择存放 KnowGap 数据的位置" "$0"
      Pop $0
      ${if} $0 != "error"
        ${NSD_SetText} $kgDataInput $0
      ${endif}
    FunctionEnd

    Function kgDataPageLeave
      ${NSD_GetText} $kgDataInput $0
      ; 去掉末尾的 \；选了盘符根目录就放进子文件夹
      StrCpy $1 $0 "" -1
      ${if} $1 == "\"
        StrCpy $0 $0 -1
      ${endif}
      StrLen $1 $0
      ${if} $1 == 2
        StrCpy $0 "$0\${KG_DATA_NAME}"
      ${endif}
      ; 必须是 X:\… 这样的完整路径
      StrCpy $1 $0 1 1
      StrCpy $2 $0 1 2
      ${if} $1 != ":"
      ${orIf} $2 != "\"
        MessageBox MB_ICONEXCLAMATION "请填写完整的文件夹路径，例如 D:\${KG_DATA_NAME}。"
        Abort
      ${endif}
      ; 不能放在安装目录里：升级时安装目录会被整个清空
      Call kgEffectiveInstDir
      StrLen $3 $R9
      StrCpy $4 $0 $3
      StrCpy $5 $0 1 $3
      ${if} $4 == $R9
        ${if} $5 == ""
        ${orIf} $5 == "\"
          MessageBox MB_ICONEXCLAMATION "数据文件夹不能放在安装目录（$R9）里：升级时安装目录会被清空。请换一个位置。"
          Abort
        ${endif}
      ${endif}
      ; 安装目录也不能放在数据文件夹里
      StrLen $3 $0
      StrCpy $4 $R9 $3
      StrCpy $5 $R9 1 $3
      ${if} $4 == $0
      ${andIf} $5 == "\"
        MessageBox MB_ICONEXCLAMATION "安装目录（$R9）不能放在数据文件夹里。请换一个数据文件夹。"
        Abort
      ${endif}
      ; 已有别的内容、又不是 KnowGap 数据的文件夹：数据放进子文件夹，免得和别的文件混在一起
      !insertmacro kgUserContext
      StrCpy $9 "${KG_POINTER_DIR}"
      !insertmacro kgRestoreContext
      ${if} $0 != $9
      ${andIf} ${FileExists} "$0\*.*"
        ${ifNot} ${FileExists} "$0\knowgap.sqlite3"
        ${andIfNot} ${FileExists} "$0\desktop-settings.json"
          StrCpy $8 ""
          FindFirst $6 $7 "$0\*.*"
          ${doWhile} $7 != ""
            ${if} $7 != "."
            ${andIf} $7 != ".."
              StrCpy $8 "1"
              ${exitDo}
            ${endif}
            FindNext $6 $7
          ${loop}
          FindClose $6
          StrCpy $1 $0 "" -12
          ${if} $8 == "1"
          ${andIf} $1 != "${KG_DATA_NAME}"
            StrCpy $0 "$0\${KG_DATA_NAME}"
          ${endif}
        ${endif}
      ${endif}
      ClearErrors
      CreateDirectory "$0"
      ${ifNot} ${FileExists} "$0\*.*"
        MessageBox MB_ICONEXCLAMATION "无法创建文件夹「$0」，请检查磁盘和权限，或换一个位置。"
        Abort
      ${endif}
      StrCpy $kgDataDir $0
    FunctionEnd
  !macroend

  ; 写指针。静默升级不经过数据文件夹页，$kgDataDir 为空，指针保持不变
  !macro customInstall
    ${if} $kgDataDir != ""
      !insertmacro kgUserContext
      CreateDirectory "${KG_POINTER_DIR}"
      FileOpen $0 "${KG_POINTER}" w
      FileWriteWord $0 65279
      FileWriteUTF16LE $0 $kgDataDir
      FileClose $0
      !insertmacro kgRestoreContext
    ${endif}
  !macroend
!endif

; 卸载时询问是否同时删除学习数据。升级安装（--updated）和静默卸载（/S）一律不删、不问。
; 数据可能在安装时选的文件夹里：先按指针删它（确认里面是 KnowGap 数据才删），再删默认位置。
!macro customUnInstall
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除学习数据？$\r$\n$\r$\n包括对话、学习空间、学习记忆、日程，以及保存的模型配置（含 API Key）。$\r$\n删除后无法恢复。选「否」会保留，重新安装后可以继续使用。" /SD IDNO IDNO keepKnowGapData
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    StrCpy $R2 ""
    ClearErrors
    FileOpen $R0 "$APPDATA\knowgap-desktop\data-location.txt" r
    ${ifNot} ${Errors}
      FileReadWord $R0 $R1
      ${if} $R1 == 65279
        FileReadUTF16LE $R0 $R2
      ${endif}
      FileClose $R0
    ${endif}
    ${if} $R2 != ""
      ${if} ${FileExists} "$R2\knowgap.sqlite3"
      ${orIf} ${FileExists} "$R2\desktop-settings.json"
        RMDir /r "$R2"
      ${endif}
    ${endif}
    RMDir /r "$APPDATA\knowgap-desktop"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
    keepKnowGapData:
  ${endIf}
!macroend
