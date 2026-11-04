# 注册 gpsstamp:// 协议（当前用户，无需管理员）
# PhotoCove 点击文件夹时用这个协议唤起 GPSStamp。
$ErrorActionPreference = 'Stop'

$bat = Join-Path $PSScriptRoot 'GPSStamp.bat'
if (-not (Test-Path -LiteralPath $bat)) {
    Write-Host ''
    Write-Host '  GPSStamp.bat not found next to this script.' -ForegroundColor Red
    Write-Host '  ' $PSScriptRoot
    exit 1
}

$root = 'HKCU:\Software\Classes\gpsstamp'
try {
    New-Item -Path $root -Force | Out-Null
    New-ItemProperty -Path $root -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    Set-Item -Path $root -Value 'URL:GPSStamp Protocol'

    $cmdKey = Join-Path $root 'shell\open\command'
    New-Item -Path $cmdKey -Force | Out-Null
    Set-Item -Path $cmdKey -Value ('"' + $bat + '" "%1"')
} catch {
    Write-Host ''
    Write-Host '  Failed to write registry: ' + $_.Exception.Message -ForegroundColor Red
    exit 1
}

$saved = (Get-ItemProperty -Path (Join-Path $root 'shell\open\command')).'(default)'
Write-Host ''
Write-Host '  gpsstamp:// registered.' -ForegroundColor Green
Write-Host ('  handler : ' + $saved)
Write-Host ''
Write-Host '  Now click a folder in PhotoCove map view.'
Write-Host '  Chrome asks once for permission - tick "Always allow".'
Write-Host ''
