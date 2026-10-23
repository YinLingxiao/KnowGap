; 卸载时询问是否同时删除学习数据。升级安装（--updated）和静默卸载（/S）一律不删、不问。
!macro customUnInstall
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除学习数据？$\r$\n$\r$\n包括对话、学习空间、学习记忆、日程，以及保存的模型配置（含 API Key）。$\r$\n删除后无法恢复。选「否」会保留，重新安装后可以继续使用。" /SD IDNO IDNO keepKnowGapData
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$APPDATA\knowgap-desktop"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
    keepKnowGapData:
  ${endIf}
!macroend
