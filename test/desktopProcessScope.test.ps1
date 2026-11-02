$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts/restart-codex-desktop-live.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Restart script parse failure'}
$definition=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-CodexDesktopProcesses'},$true)
. ([scriptblock]::Create($definition[0].Extent.Text))
$app='C:\Program Files\WindowsApps\OpenAI.Codex_test\app\ChatGPT.exe'
$script:fixtures=@(
 [pscustomobject]@{ProcessId=101;ExecutablePath=$app;CommandLine='';Name='ChatGPT.exe'},
 [pscustomobject]@{ProcessId=102;ExecutablePath='C:\legacy\app\Codex.exe';CommandLine='';Name='Codex.exe'},
 [pscustomobject]@{ProcessId=103;ExecutablePath='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';CommandLine=('-CodexAppPath "'+$app+'"');Name='powershell.exe'},
 [pscustomobject]@{ProcessId=104;ExecutablePath='C:\Other\ChatGPT.exe';CommandLine='';Name='ChatGPT.exe'},
 [pscustomobject]@{ProcessId=$PID;ExecutablePath=$app;CommandLine='';Name='ChatGPT.exe'},
 [pscustomobject]@{ProcessId=106;ExecutablePath=$null;CommandLine=('-CodexAppPath "'+$app+'"');Name='powershell.exe'}
)
function Get-CimInstance {param($ClassName) $script:fixtures}
$ids=@(Get-CodexDesktopProcesses | Select-Object -ExpandProperty ProcessId)
if(($ids -join ',') -ne '101,102'){throw 'Desktop process scope regression'}
[pscustomobject]@{passed=$true;cases=6;selectedIds=$ids;helperExcluded=$true;selfExcluded=$true}|ConvertTo-Json -Compress

