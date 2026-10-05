param([switch]$Setup)
$ErrorActionPreference = 'Stop'
$setupRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $setupRoot

function Test-Node($Candidate) {
  if (-not $Candidate) { return $false }
  $version = & $Candidate -p 'parseInt(process.versions.node)' 2>$null
  $npmCli = Join-Path (Split-Path -Parent $Candidate) 'node_modules\npm\bin\npm-cli.js'
  return $LASTEXITCODE -eq 0 -and [int]$version -ge 22 -and (Test-Path -LiteralPath $npmCli)
}

try {
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
  $arch = switch ($architecture) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw 'Windows x64 or ARM64 is required.' }
  }
  $runtimeDir = Join-Path $setupRoot ".runtime\win32-$arch"
  $nodePath = $null
  foreach ($systemNode in Get-Command node -CommandType Application -All -ErrorAction SilentlyContinue) {
    if (Test-Node $systemNode.Source) { $nodePath = $systemNode.Source; break }
  }
  if (-not $nodePath -and (Test-Path -LiteralPath $runtimeDir)) {
    foreach ($folder in Get-ChildItem -LiteralPath $runtimeDir -Directory -Filter "node-v22.*-win-$arch") {
      $candidate = Join-Path $folder.FullName 'node.exe'
      if ((Test-Path -LiteralPath $candidate) -and (Test-Node $candidate)) { $nodePath = $candidate; break }
    }
  }
  if (-not $nodePath -and -not $Setup) {
    throw 'Node.js is missing or too old. Run the installation .cmd in the project root first.'
  }
  if (-not $nodePath) {
    Write-Host '[setup] Preparing a project-local Node.js 22 runtime...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $proxy = $env:HTTPS_PROXY
    if (-not $proxy) { $proxy = $env:HTTP_PROXY }
    if (-not $proxy) {
      $commonPorts = @(7890, 7897, 10809, 10808)
      foreach ($p in $commonPorts) {
        $socket = New-Object Net.Sockets.TcpClient
        try {
          $connection = $socket.BeginConnect('127.0.0.1', $p, $null, $null)
          if ($connection.AsyncWaitHandle.WaitOne(200) -and $socket.Connected) {
            $proxy = "http://127.0.0.1:$p"
            break
          }
        } catch { } finally { $socket.Close() }
      }
    }
    $webOptions = @{ UseBasicParsing = $true; TimeoutSec = 180 }
    if ($proxy) { $webOptions.Proxy = $proxy; $env:HTTPS_PROXY = $proxy; $env:HTTP_PROXY = $proxy }
    $base = 'https://nodejs.org/download/release/latest-v22.x'
    $manifest = (Invoke-WebRequest "$base/SHASUMS256.txt" @webOptions).Content
    $match = [regex]::Match($manifest, "(?m)^([a-f0-9]{64})\s+(node-v22\.[0-9.]+-win-$arch\.zip)\s*$")
    if (-not $match.Success) { throw 'No matching Node.js archive in the official release manifest.' }
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $archive = Join-Path $runtimeDir $match.Groups[2].Value
    Invoke-WebRequest "$base/$($match.Groups[2].Value)" -OutFile $archive @webOptions
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) {
      throw 'Node.js download checksum mismatch. Run installation again.'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDir -Force
    $nodePath = Join-Path $runtimeDir ($match.Groups[2].Value.Replace('.zip', '') + '\node.exe')
    if (-not (Test-Node $nodePath)) { throw 'Downloaded Node.js could not run.' }
  }
  $env:PATH = (Split-Path -Parent $nodePath) + ';' + $env:PATH
  if ($Setup) {
    & $nodePath (Join-Path $PSScriptRoot 'setup.js')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $nodePath (Join-Path $PSScriptRoot 'launch.js') --no-build
  } else {
    & $nodePath (Join-Path $PSScriptRoot 'launch.js')
  }
  exit $LASTEXITCODE
} catch {
  Write-Host "[setup] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
