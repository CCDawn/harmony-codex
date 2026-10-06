param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$Repo
)

$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Codex 手机链路.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $ExePath
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $Repo
$shortcut.WindowStyle = 1
$shortcut.IconLocation = "$ExePath,0"
$shortcut.Save()
foreach ($name in @('启动 Codex 远程链路.lnk', '强制重建 Codex 远程链路.lnk')) {
  $old = Join-Path $desktop $name
  if (Test-Path -LiteralPath $old) {
    $archive = Join-Path $Repo 'logs\state\legacy-shortcuts'
    New-Item -ItemType Directory -Force -Path $archive | Out-Null
    Copy-Item -LiteralPath $old -Destination (Join-Path $archive $name) -Force
    Remove-Item -LiteralPath $old
  }
}
