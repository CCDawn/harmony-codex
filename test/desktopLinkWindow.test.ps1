[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$output=Join-Path $repo 'tmp/tests/DesktopLinkWindowTests.exe'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
& $compiler /nologo /target:exe /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "/out:$output" (Join-Path $repo 'scripts/windows-launcher/LinkStatusPresentation.cs') (Join-Path $repo 'scripts/windows-launcher/LinkStatusForm.cs') (Join-Path $repo 'test/windows/LinkStatusFormTests.cs')
if($LASTEXITCODE -ne 0){throw 'Desktop status test build failed'}
& $output
if($LASTEXITCODE -ne 0){throw 'Desktop status behavior checks failed'}
