# End-to-end check: one process serves the unified site, another resolves it by
# address through the DHT. The gateway also adds the browser bar and redirects
# the address form.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:OPENWEB_DEBUG = '1'

$state = Join-Path $root '.test-openweb'
Remove-Item -Recurse -Force $state -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $state | Out-Null

$nodeOut = Join-Path $state 'node.out'
$nodeErr = Join-Path $state 'node.err'
$gwOut = Join-Path $state 'gw.out'
$gwErr = Join-Path $state 'gw.err'

function Wait-For([string]$file, [string]$pattern, [int]$seconds) {
  for ($i = 0; $i -lt $seconds * 4; $i++) {
    if ((Test-Path $file) -and (Select-String -Path $file -Pattern $pattern -Quiet)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

$node = Start-Process node -ArgumentList 'packages/cli/dist/index.js', 'serve', 'app', '--dir', '.test-openweb', '--port', '7777' `
  -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr -PassThru -NoNewWindow

$gw = $null
try {
  if (-not (Wait-For $nodeOut 'address' 30)) { throw 'node did not come online' }

  $address = (Select-String -Path $nodeOut -Pattern 'ow1[a-z2-7]{52}').Matches[0].Value
  Write-Host "node address: $address"
  Write-Host ''

  $gw = Start-Process node -ArgumentList 'packages/cli/dist/index.js', 'gateway', '--dir', '.test-openweb', '--port', '8080' `
    -RedirectStandardOutput $gwOut -RedirectStandardError $gwErr -PassThru -NoNewWindow

  if (-not (Wait-For $gwOut 'listening' 20)) { throw 'gateway did not start' }

  $url = "http://127.0.0.1:8080/$address/"
  $html = (curl.exe -s --max-time 40 $url) -join "`n"
  $css = (curl.exe -s --max-time 40 "${url}style.css") -join "`n"

  Write-Host "GET $url"
  Write-Host $html
  Write-Host ''
  Write-Host "GET ${url}style.css"
  Write-Host $css
  Write-Host ''

  if ($html -notmatch 'The browser is the internet') { throw 'index.html did not arrive intact' }
  if ($css -notmatch 'color-scheme') { throw 'style.css did not arrive' }
  if ($html -notmatch 'ow-browser') { throw 'the browser bar was not injected' }
  if ($html -notmatch "/$address/style.css") { throw 'root-relative CSS was not rewritten' }

  Write-Host '--- address bar redirect ---'
  $redirect = curl.exe -s -o NUL -w '%{http_code} %{redirect_url}' "http://127.0.0.1:8080/open?to=$address/coffee.html"
  Write-Host $redirect
  if ($redirect -notmatch '^302 ') { throw 'address bar did not redirect' }
  if ($redirect -notmatch "/$address/coffee.html") { throw 'address bar redirected to the wrong page' }

  Write-Host ''
  Write-Host 'E2E OK: one signed site, two processes, browser bar, no server in the middle.'
}
finally {
  if ($gw) { Stop-Process -Id $gw.Id -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $node.Id -Force -ErrorAction SilentlyContinue

  foreach ($log in @($nodeErr, $gwErr)) {
    if (Test-Path $log) {
      $text = Get-Content $log -Raw
      if ($text) { Write-Host "stderr ($log):`n$text" }
    }
  }
  Remove-Item -Recurse -Force $state -ErrorAction SilentlyContinue
}
