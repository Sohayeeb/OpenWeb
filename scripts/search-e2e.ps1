# End-to-end search check: the unified site and a protocol fixture, one gateway,
# one local index. The crawler sees pages without the browser bar; the browser
# sees the bar on pages that opt in.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:OPENWEB_DEBUG = '1'

$state = Join-Path $root '.test-search'
Remove-Item -Recurse -Force $state -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $state | Out-Null

function Wait-For([string]$file, [string]$pattern, [int]$seconds) {
  for ($i = 0; $i -lt $seconds * 4; $i++) {
    if ((Test-Path $file) -and (Select-String -Path $file -Pattern $pattern -Quiet)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Get-Address([string]$file) {
  return (Select-String -Path $file -Pattern 'ow1[a-z2-7]{52}').Matches[0].Value
}

$procs = @()
try {
  $a = Start-Process node -ArgumentList 'packages/cli/dist/index.js', 'serve', 'app', '--dir', '.test-search/a', '--port', '7777' `
    -RedirectStandardOutput '.test-search/a.out' -RedirectStandardError '.test-search/a.err' -PassThru -NoNewWindow
  $procs += $a
  $b = Start-Process node -ArgumentList 'packages/cli/dist/index.js', 'serve', 'examples/hello', '--dir', '.test-search/b', '--port', '7778' `
    -RedirectStandardOutput '.test-search/b.out' -RedirectStandardError '.test-search/b.err' -PassThru -NoNewWindow
  $procs += $b

  if (-not (Wait-For '.test-search/a.out' 'address' 40)) { throw 'site A did not come online' }
  if (-not (Wait-For '.test-search/b.out' 'address' 40)) { throw 'site B did not come online' }
  $addrA = Get-Address '.test-search/a.out'
  $addrB = Get-Address '.test-search/b.out'
  Write-Host "site A (unified): $addrA"
  Write-Host "site B (fixture): $addrB"
  Write-Host ''

  $gw = Start-Process node -ArgumentList 'packages/cli/dist/index.js', 'gateway', '--dir', '.test-search/gw', '--port', '8080' `
    -RedirectStandardOutput '.test-search/gw.out' -RedirectStandardError '.test-search/gw.err' -PassThru -NoNewWindow
  $procs += $gw
  if (-not (Wait-For '.test-search/gw.out' 'listening' 20)) { throw 'gateway did not start' }

  Write-Host '--- crawl ---'
  node packages/cli/dist/index.js crawl $addrA $addrB --dir .test-search/gw --max 40
  if ($LASTEXITCODE -ne 0) { throw 'crawl failed' }

  Write-Host ''
  Write-Host '--- search: compost (expect garden) ---'
  $compost = (node packages/cli/dist/index.js search compost --dir .test-search/gw) -join "`n"
  $compost | Out-Host
  if ($compost -notmatch 'Tomatoes') { throw 'compost did not find the garden' }

  Write-Host '--- search: folder (expect hello) ---'
  $folder = (node packages/cli/dist/index.js search folder --dir .test-search/gw) -join "`n"
  $folder | Out-Host
  if ($folder -notmatch 'Hello from a laptop') { throw 'folder did not find the hello page' }

  Write-Host '--- search: coffee (expect coffee page) ---'
  $coffee = (node packages/cli/dist/index.js search coffee --dir .test-search/gw) -join "`n"
  $coffee | Out-Host
  if ($coffee -notmatch 'Coffee, one cup') { throw 'coffee page not indexed' }

  Write-Host '--- search: nothing (expect empty) ---'
  $none = (node packages/cli/dist/index.js search xylophone --dir .test-search/gw) -join "`n"
  if ($none -notmatch '0 result') { throw 'expected no results' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host '--- gateway /search?q=coffee ---'
  $page = (curl.exe -s --max-time 30 'http://127.0.0.1:8080/search?q=coffee') -join "`n"
  if ($page -notmatch 'Coffee, one cup') { throw 'search page did not render the coffee result' }
  if ($page -notmatch 'no personalization') { throw 'search page lost its principles' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host '--- gateway /sites (both addresses, grouped) ---'
  $sites = (curl.exe -s --max-time 20 'http://127.0.0.1:8080/sites') -join "`n"
  if ($sites -notmatch $addrA) { throw 'sites page is missing the unified site' }
  if ($sites -notmatch $addrB) { throw 'sites page is missing the fixture site' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host '--- browser bar: opt-in only ---'
  $siteA = (curl.exe -s --max-time 40 "http://127.0.0.1:8080/$addrA/") -join "`n"
  $siteB = (curl.exe -s --max-time 40 "http://127.0.0.1:8080/$addrB/") -join "`n"
  if ($siteA -notmatch 'ow-browser') { throw 'unified site did not get the browser bar' }
  if ($siteB -match 'ow-browser') { throw 'plain fixture site should not get the browser bar' }
  if ($siteA -notmatch "/$addrA/style.css") { throw 'root-relative link was not rewritten to the site' }
  Write-Host 'ok'

  Write-Host ''
  Write-Host 'SEARCH E2E OK: crawled two peers, indexed the unified site, queried by CLI and browser.'
}
finally {
  foreach ($proc in $procs) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  foreach ($log in @('.test-search/a.err', '.test-search/b.err', '.test-search/gw.err')) {
    if (Test-Path $log) {
      $text = Get-Content $log -Raw
      if ($text) { Write-Host "stderr ($log):`n$text" }
    }
  }
}
