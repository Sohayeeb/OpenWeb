# Feature e2e: the whole stack (site + gateway + crawler), the Chrome-style
# new tab, the signed directory API, the builder, a peer-published index, and
# pinning. Everything runs on loopback against the real DHT stack.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:OPENWEB_DEBUG = '1'

$state = Join-Path $root '.test-features'
Remove-Item -Recurse -Force $state -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $state | Out-Null

$procs = @()

function Wait-For([string]$file, [string]$pattern, [int]$seconds) {
  for ($i = 0; $i -lt $seconds * 4; $i++) {
    if ((Test-Path $file) -and (Select-String -Path $file -Pattern $pattern -Quiet)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Get-FirstAddress([string]$file) {
  return (Select-String -Path $file -Pattern 'ow1[a-z2-7]{52}').Matches[0].Value
}

function Add-Proc($process) {
  $script:procs += $process
}

function Get-Text([string]$url) {
  return (curl.exe -s --max-time 45 $url) -join "`n"
}

try {
  Write-Host '--- start: site + gateway + crawl ---'
  $start = Start-Process node -ArgumentList 'packages/cli/dist/index.js', 'start', 'app', '--dir', "`"$state`"", '--port', '7777', '--gateway-port', '8181' `
    -RedirectStandardOutput "$state/start.out" -RedirectStandardError "$state/start.err" -PassThru -NoNewWindow
  Add-Proc $start
  if (-not (Wait-For "$state/start.out" 'Ctrl\+C to stop' 60)) { throw 'stack did not start' }
  $site = Get-FirstAddress "$state/start.out"
  Write-Host "site: $site"
  if (-not (Select-String -Path "$state/start.out" -Pattern 'indexed \d+ page' -Quiet)) {
    throw 'the crawler did not index the site'
  }

  Write-Host ''
  Write-Host '--- gateway: Chrome-style new tab + app launcher ---'
  $homePage = Get-Text 'http://127.0.0.1:8181/'
  if ($homePage -notmatch 'ow-home-search') { throw 'new tab lost its search bar' }
  if ($homePage -notmatch 'ow-apps') { throw 'new tab lost the app launcher' }
  if ($homePage -notmatch 'manifest.webmanifest') { throw 'new tab is not installable' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host '--- published homepage + browser chrome ---'
  $siteHome = Get-Text "http://127.0.0.1:8181/$site/"
  if ($siteHome -notmatch 'served by the people who write it') { throw 'the new homepage did not load' }
  if ($siteHome -notmatch 'launcher-panel') { throw 'the homepage app launcher is missing' }
  if ($siteHome -notmatch 'ow-browser') { throw 'browser chrome missing' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host '--- search JSON uses the SQLite index ---'
  $json = Get-Text 'http://127.0.0.1:8181/search?q=tomato&format=json'
  $result = $json | ConvertFrom-Json
  if ($result.indexed -lt 5) { throw 'the index looks empty' }
  if ($result.total -lt 1) { throw 'tomato did not match anything' }
  Write-Host "indexed $($result.indexed), matched $($result.total)"

  Write-Host ''
  Write-Host '--- signed directory: create, add, JSON API ---'
  node packages/cli/dist/index.js directory init --dir $state --name 'Feature list'
  node packages/cli/dist/index.js directory add $site --dir $state --title 'OpenWeb demo' --tag demo
  $directoryJson = Get-Text 'http://127.0.0.1:8181/directory?format=json'
  $directory = $directoryJson | ConvertFrom-Json
  if (-not $directory.valid) {
    Write-Host "directory JSON: $directoryJson"
    throw 'the gateway served an invalid directory'
  }
  if ($directory.sites.Count -ne 1) { throw 'the directory does not contain the site' }
  if ($directory.sites[0].address -ne $site) { throw 'the directory site address is wrong' }
  if (-not $directory.signed.payload.entries[0].signature) { throw 'the signed JSON is missing' }
  Write-Host "verified directory by $($directory.author)"

  Write-Host ''
  Write-Host '--- builder: GET and server-side POST ---'
  $builder = Get-Text 'http://127.0.0.1:8181/builder'
  if ($builder -notmatch 'Make a page without a framework') { throw 'builder page missing' }
  $built = (curl.exe -s --max-time 30 -X POST --data-urlencode 'title=Feature page' --data-urlencode 'tagline=Made in e2e' --data-urlencode 'description=Hello from the builder' 'http://127.0.0.1:8181/builder') -join "`n"
  if ($built -notmatch 'Made in e2e') { throw 'builder preview missing the tagline' }
  if ($built -notmatch 'Feature page') { throw 'builder preview missing the title' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host '--- PWA: manifest, worker, generated icon ---'
  $manifest = Get-Text 'http://127.0.0.1:8181/manifest.webmanifest'
  if ($manifest -notmatch '"name"\s*:\s*"OpenWeb"') { throw 'web manifest is wrong' }
  $worker = Get-Text 'http://127.0.0.1:8181/sw.js'
  if ($worker -notmatch 'openweb-shell') { throw 'service worker is missing' }
  $icon = Join-Path $state 'icon.png'
  curl.exe -s --max-time 20 -o $icon 'http://127.0.0.1:8181/icon-192.png'
  if ((Get-Item $icon).Length -lt 500) { throw 'the generated icon is too small' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host '--- local index stats ---'
  $stats = ((node packages/cli/dist/index.js index stats --dir $state --json) -join "`n") | ConvertFrom-Json
  if ($stats.documents -lt 5) { throw 'index stats look empty' }
  if ($stats.terms -lt 20) { throw 'index has too few terms' }
  Write-Host "$($stats.documents) documents, $($stats.terms) terms, $([math]::Round($stats.bytes / 1024)) KB"

  Write-Host ''
  Write-Host '--- shared index: publish, fetch, query ---'
  $publisher = Start-Process node -ArgumentList 'packages/cli/dist/index.js', 'index', 'publish', '--dir', "`"$state`"" `
    -RedirectStandardOutput "$state/share.out" -RedirectStandardError "$state/share.err" -PassThru -NoNewWindow
  Add-Proc $publisher
  if (-not (Wait-For "$state/share.out" 'shared index published' 60)) { throw 'index publish did not start' }
  $indexAddress = Get-FirstAddress "$state/share.out"
  Write-Host "index address: $indexAddress"

  $clientDir = Join-Path $state 'client'
  $fetched = (node packages/cli/dist/index.js index fetch $indexAddress --dir $clientDir --timeout 60) -join "`n"
  if ($fetched -notmatch 'shared index fetched and verified') { throw 'index fetch failed' }
  $queried = (node packages/cli/dist/index.js index query $indexAddress 'tomato' --dir $clientDir --timeout 60) -join "`n"
  if ($queried -notmatch 'result') { throw 'shared index query returned nothing' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host '--- pin: replicate and remember the site ---'
  $pin = Start-Process node -ArgumentList 'packages/cli/dist/index.js', 'pin', $site, '--dir', "`"$state`"" `
    -RedirectStandardOutput "$state/pin.out" -RedirectStandardError "$state/pin.err" -PassThru -NoNewWindow
  Add-Proc $pin
  if (-not (Wait-For "$state/pin.out" 'pinning' 30)) { throw 'pin did not start' }
  if (-not (Wait-For "$state/pins.json" $site 90)) { throw 'pin record was not written' }
  $list = (node packages/cli/dist/index.js pin list --dir $state) -join "`n"
  if ($list -notmatch $site) { throw 'pin list does not show the site' }
  node packages/cli/dist/index.js pin remove $site --dir $state | Out-Host
  $after = (node packages/cli/dist/index.js pin list --dir $state) -join "`n"
  if ($after -match $site) { throw 'pin remove did not remove the record' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host 'FEATURES E2E OK: new tab, browser chrome, directory API, builder, PWA, shared index, pinning.'
}
finally {
  foreach ($proc in $procs) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  foreach ($log in @("$state/start.err", "$state/share.err", "$state/pin.err")) {
    if (Test-Path $log) {
      $text = Get-Content $log -Raw
      if ($text) { Write-Host "stderr ($log):`n$text" }
    }
  }
}
