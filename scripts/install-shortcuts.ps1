param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string[]]$ShortcutDirectories
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory 'dist/main/index.js'))) {
  throw '请先通过安装入口或构建命令准备应用。'
}

$nodeExecutable = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $nodeExecutable)) {
  $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
}
$outputLines = & $nodeExecutable (Join-Path $sourceDirectory 'scripts/brand-runtime.js')
if ($LASTEXITCODE -ne 0) { throw 'ensoul 应用入口准备失败。' }
$prefix = '[应用身份] '
$entryLine = @($outputLines | Where-Object { $_.StartsWith($prefix) })[-1]
if (-not $entryLine) { throw '没有获得 ensoul 可执行文件路径。' }
$executable = $entryLine.Substring($prefix.Length)
if (-not (Test-Path -LiteralPath $executable)) { throw 'ensoul 可执行文件不存在。' }

if (-not $ShortcutDirectories) {
  $ShortcutDirectories = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('Programs')
  )
}
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($directory in $ShortcutDirectories) {
  if (-not $directory) { continue }
  [void][IO.Directory]::CreateDirectory($directory)
  $shortcutPath = Join-Path $directory 'ensoul.lnk'
  $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $executable
  $shortcut.WorkingDirectory = $sourceDirectory
  $shortcut.Arguments = ''
  $shortcut.IconLocation = "$executable,0"
  $shortcut.Description = 'ensoul'
  $shortcut.WindowStyle = 1
  $shortcut.Save()
  Write-Output $shortcutPath
}
