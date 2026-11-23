param(
  [string]$GitHubUser = "yaoxipenga",
  [string]$Repo = "xiaoai-cmd",
  [string]$Branch = "main",
  [switch]$NoPush
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$OldUser = "yaoxipenga"
$CurrentRepo = "xiaoai-cmd"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 1) Replace the current GitHub user / repo name in every published text file.
$targets = @("registry.json", "plugin.json", "manifest.json", "README.md", "build.py")
foreach ($name in $targets) {
  $path = Join-Path $PSScriptRoot $name
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $text = $text.Replace("$OldUser/$CurrentRepo", "$GitHubUser/$Repo")
  $text = $text.Replace($CurrentRepo, $Repo)
  $text = $text.Replace($OldUser, $GitHubUser)
  [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}

# 2) Recompute entryHash / zipHash and rebuild the installable zip.
python build.py
if ($LASTEXITCODE -ne 0) { throw "build.py failed (python is required)" }

$registry = "https://raw.githubusercontent.com/$GitHubUser/$Repo/$Branch/registry.json"
$plugin   = "https://raw.githubusercontent.com/$GitHubUser/$Repo/$Branch/plugin.json"
$zip      = "https://raw.githubusercontent.com/$GitHubUser/$Repo/$Branch/xiaoai-text-command.jsplugin.zip"
$origin   = "https://github.com/$GitHubUser/$Repo.git"

Write-Host ""
Write-Host "Registry URL to submit:" -ForegroundColor Cyan
Write-Host "  $registry" -ForegroundColor Yellow
Write-Host "Plugin manifest        : $plugin"
Write-Host "Installable ZIP        : $zip"
Write-Host ""

if ($NoPush) { Write-Host "NoPush specified - files prepared only."; exit 0 }

# 3) Init / commit / push.
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".git"))) {
  git init
  git branch -M $Branch
}
git add -A
$status = git status --porcelain
if ($status) { git commit -m "Publish xiaoai text command plugin registry" }

$existing = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0 -or -not $existing) {
  git remote add origin $origin
} else {
  git remote set-url origin $origin
}

Write-Host "Pushing to $origin ($Branch) ..." -ForegroundColor Cyan
git push -u origin $Branch
if ($LASTEXITCODE -ne 0) {
  Write-Host "Push failed. Create the PUBLIC EMPTY repo on GitHub first, then re-run this script." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "Done. Submit this URL in Songloft:" -ForegroundColor Green
Write-Host "  $registry" -ForegroundColor Yellow
