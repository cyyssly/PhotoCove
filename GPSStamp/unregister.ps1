# 取消 gpsstamp:// 协议注册（只删除当前用户下的这一项）
$ErrorActionPreference = 'Stop'

$root = 'HKCU:\Software\Classes\gpsstamp'
if (Test-Path $root) {
    try {
        Remove-Item -Path $root -Recurse -Force
        Write-Host ''
        Write-Host '  gpsstamp:// unregistered.' -ForegroundColor Green
        Write-Host ''
    } catch {
        Write-Host ''
        Write-Host '  Failed: ' + $_.Exception.Message -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host ''
    Write-Host '  Not registered, nothing to do.'
    Write-Host ''
}
