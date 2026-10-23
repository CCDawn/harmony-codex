# Public progress contains fixed messages only; keep diagnostics elsewhere.
function Get-MobileLinkOperationKey {
  param([string]$Repo)
  $root=[IO.Path]::GetFullPath($Repo).TrimEnd('\','/').ToLowerInvariant()
  $sha=[Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-','')).Substring(0,16) }
  finally { $sha.Dispose() }
}
function Enter-MobileLinkOperationGate {
  param([string]$Repo)
  $gate=[Threading.Mutex]::new($false,('Local\CodexMobileLinkOperation-'+(Get-MobileLinkOperationKey $Repo)))
  $owns=$false
  try {
    try { $owns=$gate.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $owns=$true }
    if (-not $owns) { throw 'Operation gate timeout' }
    return $gate
  } catch { $gate.Dispose(); throw }
}
function Write-MobileLinkAtomicJson {
  param([string]$Path,[object]$Value,[int]$Depth=6)
  $dir=Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $temporary=Join-Path $dir ('.operation-'+[guid]::NewGuid().ToString('N')+'.tmp')
  try {
    [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json -Depth $Depth),[Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary,$Path) }
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Get-MobileLinkOperationMessage {
  param([string]$Phase)
  switch ($Phase) {
    'checking' { '正在检查链路与操作归属' }
    'starting_services' { '正在启动链路基础服务' }
    'connecting_desktop' { '正在连接 Codex 桌面' }
    'restarting_desktop' { '正在重启 Codex 桌面，随后验证会话读取' }
    'verifying' { '正在验证桌面连接与会话读取' }
    'ready' { '桌面连接与会话读取已通过验证' }
    'partial' { '部分通道尚未就绪，请查看检测结果' }
    'failed' { '操作未完成或等待已超时，请查看检测结果与日志' }
    'pending' { '桌面操作仍在进行，正在等待连接与会话读取完成' }
  }
}
function Get-MobileLinkOperation {
  param([string]$Repo)
  $path=Join-Path $Repo 'logs\state\mobile-link-operation.json'
  try {
    $value=Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json
    # PowerShell 7.5 materializes ISO JSON dates as DateTime. Restore explicit
    # offsets before Parse; implicit culture conversion would discard UTC kind.
    foreach($field in @('startedAt','updatedAt','completedAt','deadlineAt')) {
      if ($null -ne $value.$field) { $value.$field=([datetimeoffset]$value.$field).ToUniversalTime().ToString('o') }
    }
    if ($value.version -eq 1 -and $value.operationId -match '^[a-f0-9]{32}$' -and $value.action -in @('Start','Repair')) { return $value }
  } catch { }
  return $null
}
function Set-MobileLinkOperation {
  param([string]$Repo,[string]$OperationId,[ValidateSet('checking','starting_services','connecting_desktop','restarting_desktop','verifying','ready','partial','failed','pending')][string]$Phase)
  $gate=Enter-MobileLinkOperationGate $Repo
  try {
    $current=Get-MobileLinkOperation $Repo
    if ($null -eq $current -or $current.operationId -ne $OperationId -or -not $current.active) { return $false }
    if ([datetimeoffset]::UtcNow -ge [datetimeoffset]::Parse($current.deadlineAt)) { $Phase='failed' }
    $now=[datetime]::UtcNow.ToString('o')
    $current.phase=$Phase; $current.message=Get-MobileLinkOperationMessage $Phase; $current.updatedAt=$now
    $current.active=$Phase -notin @('ready','partial','failed')
    $current.completedAt=if($current.active){$null}else{$now}
    Write-MobileLinkAtomicJson (Join-Path $Repo 'logs\state\mobile-link-operation.json') $current
    return $true
  } finally { $gate.ReleaseMutex(); $gate.Dispose() }
}
function New-MobileLinkOperation {
  param([string]$Repo,[ValidateSet('Start','Repair')][string]$Action,[ValidateRange(1,600)][int]$TimeoutSeconds=480)
  $gate=Enter-MobileLinkOperationGate $Repo
  try {
    $current=Get-MobileLinkOperation $Repo
    if ($current -and $current.active) {
      if ([datetimeoffset]::UtcNow -lt [datetimeoffset]::Parse($current.deadlineAt)) {
        return [pscustomobject]@{operation=$current;joined=$true}
      }
      Set-MobileLinkOperation -Repo $Repo -OperationId $current.operationId -Phase failed | Out-Null
    }
    $now=[datetime]::UtcNow
    $operation=[pscustomobject][ordered]@{
      version=1; operationId=[guid]::NewGuid().ToString('N'); action=$Action; phase='checking'
      message=Get-MobileLinkOperationMessage 'checking'; startedAt=$now.ToString('o'); updatedAt=$now.ToString('o')
      completedAt=$null; active=$true; deadlineAt=$now.AddSeconds($TimeoutSeconds).ToString('o')
    }
    Write-MobileLinkAtomicJson (Join-Path $Repo 'logs\state\mobile-link-operation.json') $operation
    return [pscustomobject]@{operation=$operation;joined=$false}
  } finally { $gate.ReleaseMutex(); $gate.Dispose() }
}
