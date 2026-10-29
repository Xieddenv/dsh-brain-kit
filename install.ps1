# install.ps1 —— 把 dsh-brain-kit 装进 / 卸出当前 DSH profile
#
# 安装（默认 desktop profile）：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# 卸载（保留已安装的插件目录，只摘掉注册）：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
# 卸载并删除插件目录：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -Purge
# 顺带重启 DSH：
#   ... -Restart
#
# 做四件事：
#   1. 备份 profile/package.json（时间戳）
#   2. 插件目录复制到 <DSH_HOME>\plugins\dsh-brain-kit
#   3. profile\node_modules\@xie\dsh-brain-kit 建 junction
#   4. profile/package.json：dependencies 加 link、dsh.profile.bundles 注册
#
# 说明：不用 npm install / 不联网 / 不动 registry；卸载=把上面三步反向撤销。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::Default } catch {}

$ProfileName = 'desktop'
$DoRestart = $false
$Uninstall = $false
$Purge = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    '-Profile'   { $ProfileName = $args[$i + 1] }
    '-Restart'   { $DoRestart = $true }
    '-Uninstall' { $Uninstall = $true }
    '-Purge'     { $Purge = $true }
  }
}

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome "profiles\$ProfileName"
$PkgJson = Get-Content (Join-Path $Here 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$PkgName = $PkgJson.name                      # @xie/dsh-brain-kit
$PluginDirName = ($PkgName -split '/')[-1]    # dsh-brain-kit
$PluginDir = Join-Path $DshHome ("plugins\" + $PluginDirName)
$Link = Join-Path $ProfileDir ("node_modules\" + $PkgName)
$PkgFile = Join-Path $ProfileDir 'package.json'

Write-Host "DSH_HOME : $DshHome"
Write-Host "profile  : $ProfileName"
Write-Host "插件包名 : $PkgName"
Write-Host ""

if (-not (Test-Path $ProfileDir)) { Write-Host "找不到 profile 目录：$ProfileDir"; exit 1 }
if (-not (Test-Path $PkgFile))   { Write-Host "找不到 $PkgFile"; exit 1 }

# ── 备份 package.json（装/卸都先备份，出问题能退回）──
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = "$PkgFile.bak-brainkit-$stamp"
Copy-Item $PkgFile $Backup -Force
Write-Host "0/3 已备份：$Backup"
Write-Host ""

function Read-Pkg { Get-Content $PkgFile -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-Pkg($pkg) {
  # PS 5.1 的 -Encoding UTF8 会写 BOM，DSH 读 package.json 会报 Unexpected token，
  # 所以统一用无 BOM 写（本机 dsh-gui-url 就被这个坑过）。
  $json = $pkg | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($PkgFile, $json + "`n", [Text.UTF8Encoding]::new($false))
}

if (-not $Uninstall) {
  # ── 1) 复制插件包 ──
  New-Item -ItemType Directory -Force -Path (Split-Path $PluginDir) | Out-Null
  $sameDir = $false
  try { $sameDir = (Resolve-Path $Here).Path -eq (Resolve-Path $PluginDir).Path } catch { $sameDir = $false }
  if ($sameDir) {
    Write-Host "1/3 已经在插件目录里，跳过复制"
  } elseif (Test-Path $PluginDir) {
    # 已装过：不要删目录再拷（DSH 可能正在读），逐个覆盖
    Get-ChildItem $Here -Recurse -File |
      Where-Object { $_.FullName -notmatch '\\\.git\\' } |
      ForEach-Object {
        $rel = $_.FullName.Substring($Here.Length).TrimStart('\')
        $dst = Join-Path $PluginDir $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
        Copy-Item $_.FullName $dst -Force
      }
    Write-Host "1/3 旧版本已原地更新（$PluginDir）"
  } else {
    Copy-Item $Here $PluginDir -Recurse -Force
    Write-Host "1/3 插件已复制到 $PluginDir"
  }

  # ── 2) junction ──
  New-Item -ItemType Directory -Force -Path (Split-Path $Link) | Out-Null
  if (-not (Test-Path $Link)) {
    New-Item -ItemType Junction -Path $Link -Target $PluginDir | Out-Null
    Write-Host "2/3 junction 已建：$Link"
  } else {
    Write-Host "2/3 junction 已存在（如需重建先 -Uninstall）"
  }

  # ── 3) package.json ──
  $pkg = Read-Pkg
  if (-not $pkg.PSObject.Properties['dependencies']) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
  $linkSpec = 'link:' + ($PluginDir -replace '\\', '/')
  $pkg.dependencies | Add-Member -NotePropertyName $PkgName -NotePropertyValue $linkSpec -Force
  if (-not $pkg.PSObject.Properties['dsh']) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $pkg.dsh.PSObject.Properties['profile']) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $pkg.dsh.profile.PSObject.Properties['bundles']) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }
  $bundles = @($pkg.dsh.profile.bundles)
  if ($bundles -notcontains $PkgName) { $bundles += $PkgName }
  $pkg.dsh.profile.bundles = $bundles
  Write-Pkg $pkg
  Write-Host "3/3 package.json 已更新（bundles: $($bundles -join ', ')）"

  Write-Host ""
  Write-Host "装好了。重启 DSH 后应看到一行："
  Write-Host "  [brain-kit] permission=L2 (全权) workspace=..."
  Write-Host "工具列表里会出现：brain_write"
  Write-Host ""
  Write-Host "回滚：powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall"
} else {
  # ── 卸载 ──
  if (Test-Path $Link) {
    $item = Get-Item $Link -Force
    if ($item.LinkType) { $item.Delete() } else { Remove-Item $Link -Recurse -Force }
    Write-Host "1/3 已删除 junction：$Link"
  } else {
    Write-Host "1/3 junction 不存在，跳过"
  }

  $pkg = Read-Pkg
  if ($pkg.PSObject.Properties['dependencies'] -and $pkg.dependencies.PSObject.Properties[$PkgName]) {
    $pkg.dependencies.PSObject.Properties.Remove($PkgName)
    Write-Host "2/3 已移除 dependency：$PkgName"
  } else {
    Write-Host "2/3 dependency 不存在，跳过"
  }
  if ($pkg.PSObject.Properties['dsh'] -and $pkg.dsh.PSObject.Properties['profile'] -and $pkg.dsh.profile.PSObject.Properties['bundles']) {
    $kept = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne $PkgName }
    $pkg.dsh.profile.bundles = @($kept)
    Write-Pkg $pkg
    Write-Host "3/3 bundles 已更新（剩 $($kept -join ', ')）"
  } else {
    Write-Host "3/3 bundles 字段不存在，跳过"
  }

  if ($Purge) {
    if (Test-Path $PluginDir) { Remove-Item $PluginDir -Recurse -Force; Write-Host "已删除插件目录：$PluginDir" }
  } else {
    Write-Host "（插件目录保留：$PluginDir，要删加 -Purge）"
  }
  Write-Host ""
  Write-Host "卸载完成。回滚点：$Backup"
}

if ($DoRestart) {
  Write-Host ""
  Write-Host "3 秒后重启 DSH…"
  Start-Sleep -Seconds 3
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
  if (Test-Path $exe) { Start-Process $exe }
}
