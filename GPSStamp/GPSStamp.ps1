param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$StartupFiles
)

$ErrorActionPreference = 'Stop'

$script:ImageExt = @(
    '.jpg','.jpeg','.jpe','.jfif','.tif','.tiff','.png',
    '.heic','.heif','.avif',
    '.dng','.cr2','.cr3','.nef','.nrw','.arw','.sr2','.srf','.raf','.orf','.rw2','.pef','.srw','.x3f','.3fr','.erf','.mef','.mos','.mrw',
    '.mp4','.mov'
)

$script:ScriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($script:ScriptDir)) { $script:ScriptDir = (Get-Location).Path }

function Find-ExifTool {
    $here = $script:ScriptDir
    $parent = Split-Path -Path $here -Parent
    $grand = Split-Path -Path $parent -Parent

    # 上次找到的位置记在 settings.ini 里：程序被移动/被别的程序调用时仍然能用
    $saved = ''
    try { $saved = Get-Setting 'exiftool' } catch { }

    $candidates = @()
    if ($saved) { $candidates += $saved }
    $candidates += @(
        (Join-Path $here 'exiftool.exe'),
        (Join-Path $here 'ExifToolGUI\exiftool.exe'),
        (Join-Path $parent 'exiftool.exe'),
        (Join-Path $parent 'ExifToolGUI\exiftool.exe'),
        (Join-Path $grand 'ExifToolGUI\exiftool.exe'),
        (Join-Path (Split-Path -Path $grand -Parent) 'ExifToolGUI\exiftool.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) {
            if ($c -ne $saved) { try { Set-Setting 'exiftool' $c } catch { } }
            return $c
        }
    }
    $cmd = Get-Command 'exiftool.exe' -ErrorAction SilentlyContinue
    if ($cmd) {
        if ($cmd.Source -ne $saved) { try { Set-Setting 'exiftool' $cmd.Source } catch { } }
        return $cmd.Source
    }
    return $null
}

function Get-ImageFiles {
    param([string[]]$Paths)
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($p in $Paths) {
        if ([string]::IsNullOrWhiteSpace($p)) { continue }
        if (Test-Path -LiteralPath $p -PathType Container) {
            $items = Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue
            foreach ($it in $items) {
                if ($script:ImageExt -contains $it.Extension.ToLower()) {
                    if (-not $out.Contains($it.FullName)) { $out.Add($it.FullName) }
                }
            }
        }
        elseif (Test-Path -LiteralPath $p -PathType Leaf) {
            $full = (Resolve-Path -LiteralPath $p).Path
            if (-not $out.Contains($full)) { $out.Add($full) }
        }
    }
    return ,$out.ToArray()
}

function Invoke-GpsWrite {
    param(
        [string]$ExifTool,
        [string[]]$Files,
        [string]$Coord,
        [bool]$KeepBackup,
        [scriptblock]$Logger
    )

    $chunkSize = 40
    $okCount = 0
    $failCount = 0

    for ($i = 0; $i -lt $Files.Count; $i += $chunkSize) {
        $last = [Math]::Min($i + $chunkSize - 1, $Files.Count - 1)
        $chunk = @()
        for ($j = $i; $j -le $last; $j++) { $chunk += $Files[$j] }

        # Argument file: one argument per line. Keeps Unicode paths intact
        # and avoids the "FileName encoding must be specified" warning.
        $argFile = Join-Path ([System.IO.Path]::GetTempPath()) ('gpsstamp_' + [guid]::NewGuid().ToString('N') + '.txt')
        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add('-GPSPosition=' + $Coord)
        $lines.Add('-m')
        if (-not $KeepBackup) { $lines.Add('-overwrite_original') }
        foreach ($f in $chunk) { $lines.Add($f) }
        [System.IO.File]::WriteAllLines($argFile, $lines, (New-Object System.Text.UTF8Encoding($false)))

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $ExifTool
        $psi.Arguments = '-charset filename=utf8 -@ "' + $argFile + '"'
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

        $stdout = ''
        $stderr = ''
        $exitCode = 1
        try {
            $proc = [System.Diagnostics.Process]::Start($psi)
            $stdout = $proc.StandardOutput.ReadToEnd()
            $stderr = $proc.StandardError.ReadToEnd()
            $proc.WaitForExit()
            $exitCode = $proc.ExitCode
        }
        finally {
            Remove-Item -LiteralPath $argFile -Force -ErrorAction SilentlyContinue
        }

        if ($stdout -and $stdout.Trim().Length -gt 0) { & $Logger $stdout.Trim() }
        if ($stderr -and $stderr.Trim().Length -gt 0) {
            $noise = @('perl: warning', 'locale settings', 'Falling back to the standard locale', 'LC_ALL', 'LANG =', 'installed on your system', 'Please check that your locale')
            $errLines = @()
            foreach ($line in ($stderr -split "`r?`n")) {
                $t = $line.Trim()
                if ($t.Length -eq 0) { continue }
                $skip = $false
                foreach ($n in $noise) { if ($t.Contains($n)) { $skip = $true; break } }
                if (-not $skip) { $errLines += $t }
            }
            if ($errLines.Count -gt 0) {
                $isError = $false
                foreach ($t in $errLines) {
                    if ($t -match 'Error:' -and $t -notmatch '\[minor\]') { $isError = $true; break }
                }
                if ($isError) { & $Logger ((T 'err_prefix') + ($errLines -join ' | ')) }
                else { & $Logger ((T 'note_prefix') + ($errLines -join ' | ')) }
            }
        }

        # Trust exiftool's own tally instead of the exit code:
        # a single bad file makes the exit code non-zero even when the rest succeeded.
        $updated = 0
        $failed = 0
        foreach ($m in [regex]::Matches($stdout, '(\d+) image files? updated')) { $updated += [int]$m.Groups[1].Value }
        foreach ($m in [regex]::Matches($stdout, "(\d+) files? weren't updated")) { $failed += [int]$m.Groups[1].Value }
        if ($updated -eq 0 -and $failed -eq 0) {
            if ($exitCode -eq 0) { $updated = $chunk.Count } else { $failed = $chunk.Count }
        }

        $okCount += $updated
        $failCount += $failed
    }

    return [pscustomobject]@{ Total = $Files.Count; Ok = $okCount; Fail = $failCount }
}

# 先问 exiftool「这一批里哪些还没有 GPS」，只把这些交给界面。
# 批量写入会覆盖已有坐标，直接整目录写会把已经带 GPS 的照片改坏。
function Get-FilesWithoutGps {
    param(
        [string]$ExifTool,
        [string[]]$Files
    )
    $missing = New-Object System.Collections.Generic.List[string]
    if (-not $Files -or $Files.Count -eq 0) { return ,$missing.ToArray() }

    $chunkSize = 120
    for ($i = 0; $i -lt $Files.Count; $i += $chunkSize) {
        $last = [Math]::Min($i + $chunkSize - 1, $Files.Count - 1)

        $argFile = Join-Path ([System.IO.Path]::GetTempPath()) ('gpsstamp_scan_' + [guid]::NewGuid().ToString('N') + '.txt')
        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add('-csv')
        $lines.Add('-GPSPosition')
        for ($j = $i; $j -le $last; $j++) { $lines.Add($Files[$j]) }
        [System.IO.File]::WriteAllLines($argFile, $lines, (New-Object System.Text.UTF8Encoding($false)))

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $ExifTool
        $psi.Arguments = '-charset filename=utf8 -@ "' + $argFile + '"'
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

        $stdout = ''
        try {
            $proc = [System.Diagnostics.Process]::Start($psi)
            $stdout = $proc.StandardOutput.ReadToEnd()
            [void]$proc.StandardError.ReadToEnd()
            $proc.WaitForExit()
        }
        finally {
            Remove-Item -LiteralPath $argFile -Force -ErrorAction SilentlyContinue
        }

        if ($stdout) {
            $stdout = $stdout.Trim([char]0xFEFF)
            $rows = @(($stdout -split "`r?`n") | Where-Object { $_.Trim().Length -gt 0 } | ConvertFrom-Csv)
            foreach ($row in $rows) {
                $src = $row.SourceFile
                if (-not $src) { continue }
                if ([string]::IsNullOrWhiteSpace($row.GPSPosition)) {
                    # exiftool 的 CSV 用正斜杠，转回 Windows 风格，界面里看着才一致
                    $missing.Add($src.Replace('/', '\'))
                }
            }
        }
    }

    return ,$missing.ToArray()
}

# ---------- GUI ----------

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$script:Files = New-Object System.Collections.Generic.List[string]
$script:LastDir = ''
$script:Lang = 'zh'
$script:LangInit = $false

$S = @{
    app_title       = @{ en = 'GPS Stamp'; zh = 'GPS 坐标写入' }
    coord_label     = @{ en = 'GPSPosition  (latitude,longitude)'; zh = 'GPSPosition（纬度,经度）' }
    paste           = @{ en = 'Paste'; zh = '粘贴' }
    osm             = @{ en = 'OSM'; zh = '地图' }
    hint            = @{ en = 'e.g. 39.9087,116.3975    WGS-84 only. Do not paste GCJ-02 / BD-09 coordinates from Amap or Baidu.'
                         zh = '示例 39.9087,116.3975；必须是 WGS-84 坐标，高德/百度坐标需先转换' }
    add_files       = @{ en = 'Add Files...'; zh = '添加文件...' }
    add_folder      = @{ en = 'Add Folder...'; zh = '添加文件夹...' }
    clear           = @{ en = 'Clear'; zh = '清空' }
    count_fmt       = @{ en = '{0} file(s)'; zh = '共 {0} 个文件' }
    drop_hint       = @{ en = 'Drop files or folders here'; zh = '把文件或文件夹拖到这里' }
    keep_backup     = @{ en = 'Keep _original backup (recommended)'; zh = '保留 _original 备份（推荐）' }
    write_gps       = @{ en = 'Write GPS'; zh = '写入 GPS' }
    log_label       = @{ en = 'Log'; zh = '日志' }
    dlg_select_images = @{ en = 'Select images'; zh = '选择图片' }
    dlg_select_folder = @{ en = 'Select a folder (subfolders included)'; zh = '选择文件夹（含子目录）' }

    msg_need_coord  = @{ en = 'Enter a GPSPosition first, e.g. 39.9087,116.3975'
                         zh = '请先填写坐标，例如 39.9087,116.3975' }
    msg_bad_format  = @{ en = "Coordinate format must be: latitude,longitude`r`nDecimal degrees, e.g. 39.9087,116.3975"
                         zh = "格式应为：纬度,经度（十进制度）`r`n例如 39.9087,116.3975" }
    msg_range       = @{ en = "Latitude must be -90..90, longitude -180..180.`r`nCheck the order: latitude comes first."
                         zh = "纬度需在 -90~90，经度 -180~180。`r`n注意顺序：先纬度后经度。" }
    msg_no_files    = @{ en = 'No files selected.'; zh = '还没有添加文件。' }
    msg_no_exif     = @{ en = 'exiftool.exe not found. Put it next to this script, or in ..\ExifToolGUI\.'
                         zh = '没找到 exiftool.exe。请放到本程序目录，或 ..\ExifToolGUI\ 下。' }
    confirm_title   = @{ en = 'Confirm'; zh = '确认' }
    confirm_body    = @{ en = 'Write GPSPosition {0} to {1} file(s)?'; zh = '将坐标 {0} 写入 {1} 个文件？' }
    confirm_nobackup = @{ en = 'Backup is OFF: files will be overwritten without _original copies.'
                          zh = '备份已关闭：将直接覆盖，不生成 _original 副本。' }
    done_title      = @{ en = 'GPS Stamp'; zh = 'GPS 坐标写入' }
    done_body       = @{ en = "Updated {0} / {1} file(s).`r`nSee the log for details."
                         zh = "完成：成功 {0} / 共 {1} 个。`r`n详情见日志。" }

    log_exif        = @{ en = 'exiftool: {0}'; zh = 'exiftool：{0}' }
    log_no_exif     = @{ en = 'exiftool.exe NOT found.'; zh = '未找到 exiftool.exe。' }
    log_added       = @{ en = 'Added {0} file(s).'; zh = '已添加 {0} 个文件。' }
    log_noadd       = @{ en = 'No new files added.'; zh = '没有新增文件。' }
    log_writing     = @{ en = 'Writing {0} using {1}'; zh = '正在写入 {0}，使用 {1}' }
    log_done        = @{ en = 'Done. OK={0}  Failed={1}'; zh = '完成。成功={0} 失败={1}' }
    log_failed      = @{ en = 'FAILED: {0}'; zh = '失败：{0}' }
    log_lang        = @{ en = 'Language switched to English.'; zh = '界面语言已切换为中文。' }
    log_scan_folder = @{ en = 'Opening folder: {0}'; zh = '正在打开文件夹：{0}' }
    log_dir_missing = @{ en = 'Folder not found: {0}'; zh = '文件夹不存在：{0}' }
    log_no_images   = @{ en = 'No images found in this folder.'; zh = '这个文件夹里没有可处理的图片。' }
    log_gps_scan    = @{ en = 'Checked {0} image(s): {1} without GPS.'; zh = '已检查 {0} 张，其中 {1} 张没有 GPS。' }
    log_all_have_gps = @{ en = 'All images already have GPS - nothing to do.'; zh = '这些照片都已有 GPS，无需处理。' }
    err_prefix      = @{ en = 'ERROR: '; zh = '错误：' }
    note_prefix     = @{ en = 'NOTE: '; zh = '提示：' }
}

function T {
    param([string]$Key)
    if ($S.ContainsKey($Key)) { return $S[$Key][$script:Lang] }
    return $Key
}

function Apply-Language {
    $form.Text = T 'app_title'
    $lblCoord.Text = T 'coord_label'
    $btnPaste.Text = T 'paste'
    $btnExample.Text = T 'osm'
    $lblHint.Text = T 'hint'
    $btnAdd.Text = T 'add_files'
    $btnFolder.Text = T 'add_folder'
    $btnClear.Text = T 'clear'
    $lblDrop.Text = T 'drop_hint'
    $chkBackup.Text = T 'keep_backup'
    $btnWrite.Text = T 'write_gps'
    $lblLog.Text = T 'log_label'
    Update-Count
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'GPS Stamp'
$form.Size = New-Object System.Drawing.Size(860, 640)
$form.MinimumSize = New-Object System.Drawing.Size(700, 520)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.AllowDrop = $true

$lblCoord = New-Object System.Windows.Forms.Label
$lblCoord.Text = 'GPSPosition  (latitude,longitude)'
$lblCoord.Location = New-Object System.Drawing.Point(14, 14)
$lblCoord.Size = New-Object System.Drawing.Size(320, 20)
$form.Controls.Add($lblCoord)

$txtCoord = New-Object System.Windows.Forms.TextBox
$txtCoord.Location = New-Object System.Drawing.Point(14, 36)
$txtCoord.Size = New-Object System.Drawing.Size(520, 26)
$txtCoord.Font = New-Object System.Drawing.Font('Consolas', 10)
$txtCoord.Anchor = 'Top,Left,Right'
$form.Controls.Add($txtCoord)

$btnPaste = New-Object System.Windows.Forms.Button
$btnPaste.Text = 'Paste'
$btnPaste.Location = New-Object System.Drawing.Point(542, 35)
$btnPaste.Size = New-Object System.Drawing.Size(80, 26)
$btnPaste.Anchor = 'Top,Right'
$form.Controls.Add($btnPaste)

$btnExample = New-Object System.Windows.Forms.Button
$btnExample.Text = 'OSM'
$btnExample.Location = New-Object System.Drawing.Point(628, 35)
$btnExample.Size = New-Object System.Drawing.Size(80, 26)
$btnExample.Anchor = 'Top,Right'
$form.Controls.Add($btnExample)

$cmbLang = New-Object System.Windows.Forms.ComboBox
$cmbLang.DropDownStyle = 'DropDownList'
$cmbLang.Location = New-Object System.Drawing.Point(716, 35)
$cmbLang.Size = New-Object System.Drawing.Size(104, 26)
$cmbLang.Anchor = 'Top,Right'
[void]$cmbLang.Items.Add('中文')
[void]$cmbLang.Items.Add('English')
$cmbLang.SelectedIndex = 0
$form.Controls.Add($cmbLang)

$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Text = 'e.g. 39.9087,116.3975    WGS-84 only. Do not paste GCJ-02 / BD-09 coordinates from Amap or Baidu.'
$lblHint.Location = New-Object System.Drawing.Point(14, 66)
$lblHint.Size = New-Object System.Drawing.Size(700, 18)
$lblHint.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110)
$form.Controls.Add($lblHint)

$btnAdd = New-Object System.Windows.Forms.Button
$btnAdd.Text = 'Add Files...'
$btnAdd.Location = New-Object System.Drawing.Point(14, 92)
$btnAdd.Size = New-Object System.Drawing.Size(100, 28)
$form.Controls.Add($btnAdd)

$btnFolder = New-Object System.Windows.Forms.Button
$btnFolder.Text = 'Add Folder...'
$btnFolder.Location = New-Object System.Drawing.Point(120, 92)
$btnFolder.Size = New-Object System.Drawing.Size(104, 28)
$form.Controls.Add($btnFolder)

$btnClear = New-Object System.Windows.Forms.Button
$btnClear.Text = 'Clear'
$btnClear.Location = New-Object System.Drawing.Point(230, 92)
$btnClear.Size = New-Object System.Drawing.Size(72, 28)
$form.Controls.Add($btnClear)

$lblCount = New-Object System.Windows.Forms.Label
$lblCount.Text = '0 file(s)'
$lblCount.Location = New-Object System.Drawing.Point(316, 98)
$lblCount.Size = New-Object System.Drawing.Size(200, 20)
$form.Controls.Add($lblCount)

$lblDrop = New-Object System.Windows.Forms.Label
$lblDrop.Text = 'Drop files or folders here'
$lblDrop.Location = New-Object System.Drawing.Point(560, 98)
$lblDrop.Size = New-Object System.Drawing.Size(270, 20)
$lblDrop.TextAlign = 'MiddleRight'
$lblDrop.ForeColor = [System.Drawing.Color]::FromArgb(140, 140, 140)
$lblDrop.Anchor = 'Top,Right'
$form.Controls.Add($lblDrop)

$lstFiles = New-Object System.Windows.Forms.ListBox
$lstFiles.Location = New-Object System.Drawing.Point(14, 128)
$lstFiles.Size = New-Object System.Drawing.Size(816, 220)
$lstFiles.Anchor = 'Top,Left,Right'
$lstFiles.SelectionMode = 'MultiExtended'
$lstFiles.HorizontalScrollbar = $true
$lstFiles.AllowDrop = $true
$form.Controls.Add($lstFiles)

$chkBackup = New-Object System.Windows.Forms.CheckBox
$chkBackup.Text = 'Keep _original backup (recommended)'
$chkBackup.Location = New-Object System.Drawing.Point(14, 358)
$chkBackup.Size = New-Object System.Drawing.Size(300, 24)
$chkBackup.Checked = $true
$chkBackup.Anchor = 'Top,Left'
$form.Controls.Add($chkBackup)

$btnWrite = New-Object System.Windows.Forms.Button
$btnWrite.Text = 'Write GPS'
$btnWrite.Location = New-Object System.Drawing.Point(704, 354)
$btnWrite.Size = New-Object System.Drawing.Size(126, 32)
$btnWrite.Anchor = 'Top,Right'
$btnWrite.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($btnWrite)

$lblLog = New-Object System.Windows.Forms.Label
$lblLog.Text = 'Log'
$lblLog.Location = New-Object System.Drawing.Point(14, 392)
$lblLog.Size = New-Object System.Drawing.Size(60, 18)
$form.Controls.Add($lblLog)

$txtLog = New-Object System.Windows.Forms.TextBox
$txtLog.Location = New-Object System.Drawing.Point(14, 412)
$txtLog.Size = New-Object System.Drawing.Size(816, 180)
$txtLog.Anchor = 'Top,Bottom,Left,Right'
$txtLog.Multiline = $true
$txtLog.ScrollBars = 'Vertical'
$txtLog.ReadOnly = $true
$txtLog.BackColor = [System.Drawing.Color]::White
$txtLog.Font = New-Object System.Drawing.Font('Consolas', 9)
$form.Controls.Add($txtLog)

function Write-Log {
    param([string]$Text)
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $txtLog.AppendText('[' + $stamp + '] ' + $Text + "`r`n")
    [System.Windows.Forms.Application]::DoEvents()
}

function Update-Count {
    $lblCount.Text = (T 'count_fmt') -f $script:Files.Count
}

function Add-Paths {
    param([string[]]$Paths)
    if (-not $Paths -or $Paths.Count -eq 0) { return }
    $found = Get-ImageFiles -Paths $Paths
    $added = 0
    foreach ($f in $found) {
        if (-not $script:Files.Contains($f)) {
            $script:Files.Add($f)
            [void]$lstFiles.Items.Add($f)
            $added++
        }
    }
    Update-Count
    if ($added -gt 0) {
        Write-Log ((T 'log_added') -f $added)
        $first = $Paths[0]
        if (Test-Path -LiteralPath $first -PathType Container) { Save-LastDir $first }
        elseif (Test-Path -LiteralPath $first -PathType Leaf) { Save-LastDir (Split-Path -Path $first -Parent) }
    }
    else { Write-Log (T 'log_noadd') }
}

# 被别的程序唤起（gpsstamp://…?dir=…）时的入口：只挑缺 GPS 的照片载入
function Add-FolderMissingGps {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { return }
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) {
        Write-Log ((T 'log_dir_missing') -f $Dir)
        return
    }
    Write-Log ((T 'log_scan_folder') -f $Dir)

    $files = Get-ImageFiles -Paths @($Dir)
    if (-not $files -or $files.Count -eq 0) { Write-Log (T 'log_no_images'); return }
    if (-not $script:ExifTool) { Add-Paths -Paths @($Dir); return }

    $missing = Get-FilesWithoutGps -ExifTool $script:ExifTool -Files $files
    Write-Log ((T 'log_gps_scan') -f $files.Count, $missing.Count)
    if ($missing.Count -eq 0) {
        Save-LastDir $Dir
        Write-Log (T 'log_all_have_gps')
        return
    }
    Add-Paths -Paths $missing
    Save-LastDir $Dir
}

# gpsstamp://open/?dir=<urlencoded path>  →  { Kind='dir'; Path=... }
# 普通路径（拖拽/命令行）→ { Kind='path'; Path=... }
function Get-LaunchTarget {
    param([string]$Arg)
    if ($Arg -match '^(?i)gpsstamp:') {
        $query = ''
        $q = $Arg.IndexOf('?')
        if ($q -ge 0) { $query = $Arg.Substring($q + 1) }
        foreach ($pair in ($query -split '&')) {
            if (-not $pair) { continue }
            $kv = $pair -split '=', 2
            if ($kv.Count -eq 2 -and $kv[0].ToLowerInvariant() -eq 'dir') {
                $path = ''
                try { $path = [System.Uri]::UnescapeDataString($kv[1]) } catch { $path = $kv[1] }
                return @{ Kind = 'dir'; Path = $path }
            }
        }
        return @{ Kind = 'dir'; Path = '' }
    }
    return @{ Kind = 'path'; Path = $Arg }
}

# ---- settings: settings.ini next to the script (portable);
# ---- %APPDATA%\GPSStamp is only a fallback when the app folder is read-only
$script:AppDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($script:AppDir)) { $script:AppDir = Split-Path -Path $MyInvocation.MyCommand.Path -Parent }
$script:AppDataDir = Join-Path $env:APPDATA 'GPSStamp'
$script:SettingsPath = Join-Path $script:AppDir 'settings.ini'
$script:FallbackPath = Join-Path $script:AppDataDir 'settings.ini'
$script:Settings = @{}

function Save-Settings {
    $lines = @('; GPSStamp settings, saved automatically')
    foreach ($k in @('coord', 'dir', 'backup', 'lang', 'exiftool')) {
        if ($script:Settings.ContainsKey($k) -and $script:Settings[$k].Length -gt 0) {
            $lines += ($k + '=' + $script:Settings[$k])
        }
    }
    $txt = ($lines -join "`r`n") + "`r`n"

    $targets = @($script:SettingsPath)
    if ($script:SettingsPath -ne $script:FallbackPath) { $targets += $script:FallbackPath }
    foreach ($p in $targets) {
        try {
            $dir = Split-Path -Path $p -Parent
            if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
            [System.IO.File]::WriteAllText($p, $txt, (New-Object System.Text.UTF8Encoding($false)))
            $script:SettingsPath = $p
            return
        } catch { }
    }
}

function Read-SettingsFile {
    param([string]$Path)
    $out = @{}
    try {
        if (Test-Path -LiteralPath $Path) {
            foreach ($line in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
                $t = $line.Trim()
                if ($t.Length -eq 0 -or $t.StartsWith(';') -or $t.StartsWith('#')) { continue }
                $i = $t.IndexOf('=')
                if ($i -lt 1) { continue }
                $out[$t.Substring(0, $i).Trim().ToLowerInvariant()] = $t.Substring($i + 1).Trim()
            }
        }
    } catch { }
    return $out
}

function Get-Setting {
    param([string]$Key, [string]$Default = '')
    $k = $Key.ToLowerInvariant()
    if ($script:Settings.ContainsKey($k)) { return $script:Settings[$k] }
    return $Default
}

function Set-Setting {
    param([string]$Key, [string]$Value)
    $script:Settings[$Key.ToLowerInvariant()] = $Value
    Save-Settings
}

function Load-Settings {
    $script:Settings = Read-SettingsFile $script:SettingsPath

    # settings still sitting in %APPDATA% (or the old one-value-per-file layout):
    # pull them in once and write them next to the script
    if ($script:Settings.Count -eq 0 -and $script:SettingsPath -ne $script:FallbackPath) {
        $script:Settings = Read-SettingsFile $script:FallbackPath
        if ($script:Settings.Count -gt 0) { Save-Settings }
    }

    if ($script:Settings.Count -eq 0) {
        $legacy = @{ coord = 'last.txt'; dir = 'lastdir.txt'; backup = 'backup.txt'; lang = 'lang.txt' }
        $migrated = $false
        foreach ($k in @('coord', 'dir', 'backup', 'lang')) {
            $old = Join-Path $script:AppDataDir $legacy[$k]
            try {
                if (Test-Path -LiteralPath $old) {
                    $v = [System.IO.File]::ReadAllText($old, [System.Text.Encoding]::UTF8).Trim([char]0xFEFF).Trim()
                    if ($v.Length -gt 0) { $script:Settings[$k] = $v; $migrated = $true }
                }
            } catch { }
        }
        if ($migrated) { Save-Settings }
    }
}

function Apply-Settings {
    $txtCoord.Text = Get-Setting 'coord'

    $script:LastDir = Get-Setting 'dir'
    if ($script:LastDir.Length -gt 0 -and -not (Test-Path -LiteralPath $script:LastDir)) { $script:LastDir = '' }

    $chkBackup.Checked = ((Get-Setting 'backup' '1') -ne '0')

    $lang = (Get-Setting 'lang').ToLowerInvariant()
    if ($lang -eq 'zh' -or $lang -eq 'en') {
        $script:Lang = $lang
    } else {
        try {
            $ui = [System.Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName
            if ($ui -ne 'zh') { $script:Lang = 'en' }
        } catch { }
    }
}

function Save-LastCoord { Set-Setting 'coord' $txtCoord.Text.Trim() }

function Save-LastDir {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $script:LastDir = $Path
    Set-Setting 'dir' $Path
}

function Save-BackupPref {
    $v = '0'
    if ($chkBackup.Checked) { $v = '1' }
    Set-Setting 'backup' $v
}

function Save-Lang { Set-Setting 'lang' $script:Lang }

$form.Add_DragEnter({
    param($s, $e)
    if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
        $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy
    }
})

$form.Add_DragDrop({
    param($s, $e)
    $paths = $e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
    if ($paths) { Add-Paths -Paths $paths }
})

$lstFiles.Add_DragEnter({
    param($s, $e)
    if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
        $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy
    }
})

$lstFiles.Add_DragDrop({
    param($s, $e)
    $paths = $e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
    if ($paths) { Add-Paths -Paths $paths }
})

$btnPaste.Add_Click({
    try {
        $text = [System.Windows.Forms.Clipboard]::GetText()
        if ($text) { $txtCoord.Text = $text.Trim() }
    } catch { }
})

$btnExample.Add_Click({
    Start-Process 'https://www.openstreetmap.org/'
})

$btnAdd.Add_Click({
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Multiselect = $true
    $dlg.Title = T 'dlg_select_images'
    $dlg.Filter = 'Images|*.jpg;*.jpeg;*.jpe;*.tif;*.tiff;*.png;*.heic;*.heif;*.dng;*.cr2;*.cr3;*.nef;*.arw;*.raf;*.orf;*.rw2;*.pef;*.srw;*.mp4;*.mov|All files|*.*'
    if ($script:LastDir.Length -gt 0 -and (Test-Path -LiteralPath $script:LastDir)) {
        $dlg.InitialDirectory = $script:LastDir
    }
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Add-Paths -Paths $dlg.FileNames
    }
})

$btnFolder.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = T 'dlg_select_folder'
    if ($script:LastDir.Length -gt 0 -and (Test-Path -LiteralPath $script:LastDir)) {
        $dlg.SelectedPath = $script:LastDir
    }
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Add-Paths -Paths @($dlg.SelectedPath)
    }
})

$btnClear.Add_Click({
    $script:Files.Clear()
    $lstFiles.Items.Clear()
    Update-Count
})

$btnWrite.Add_Click({
    $coord = $txtCoord.Text.Trim()
    if ($coord.Length -eq 0) {
        [void][System.Windows.Forms.MessageBox]::Show((T 'msg_need_coord'), (T 'app_title'))
        return
    }

    $coord = $coord.Replace([char]0xFF0C, ',').Replace([char]0xFF1B, ',')
    $m = [regex]::Match($coord, '^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$')
    if (-not $m.Success) {
        [void][System.Windows.Forms.MessageBox]::Show((T 'msg_bad_format'), (T 'app_title'), [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
        return
    }
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $lat = 0.0
    $lon = 0.0
    $latOk = [double]::TryParse($m.Groups[1].Value, [System.Globalization.NumberStyles]::Float, $inv, [ref]$lat)
    $lonOk = [double]::TryParse($m.Groups[2].Value, [System.Globalization.NumberStyles]::Float, $inv, [ref]$lon)
    if (-not $latOk -or -not $lonOk -or $lat -lt -90 -or $lat -gt 90 -or $lon -lt -180 -or $lon -gt 180) {
        [void][System.Windows.Forms.MessageBox]::Show((T 'msg_range'), (T 'app_title'), [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
        return
    }
    $coord = $lat.ToString($inv) + ',' + $lon.ToString($inv)
    $txtCoord.Text = $coord
    if ($script:Files.Count -eq 0) {
        [void][System.Windows.Forms.MessageBox]::Show((T 'msg_no_files'), (T 'app_title'))
        return
    }
    if (-not $script:ExifTool) {
        [void][System.Windows.Forms.MessageBox]::Show((T 'msg_no_exif'), (T 'app_title'))
        return
    }

    $msg = (T 'confirm_body') -f $coord, $script:Files.Count
    if (-not $chkBackup.Checked) { $msg += "`r`n`r`n" + (T 'confirm_nobackup') }
    $answer = [System.Windows.Forms.MessageBox]::Show($msg, (T 'confirm_title'), [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }

    $btnWrite.Enabled = $false
    $btnAdd.Enabled = $false
    $btnFolder.Enabled = $false
    $btnClear.Enabled = $false
    $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    Save-LastCoord
    Write-Log ((T 'log_writing') -f $coord, $script:ExifTool)

    try {
        $res = Invoke-GpsWrite -ExifTool $script:ExifTool -Files $script:Files.ToArray() -Coord $coord -KeepBackup $chkBackup.Checked -Logger ${function:Write-Log}
        Write-Log ((T 'log_done') -f $res.Ok, $res.Fail)
        $icon = [System.Windows.Forms.MessageBoxIcon]::Information
        if ($res.Fail -gt 0) { $icon = [System.Windows.Forms.MessageBoxIcon]::Warning }
        [void][System.Windows.Forms.MessageBox]::Show(((T 'done_body') -f $res.Ok, $res.Total), (T 'done_title'), [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
    }
    catch {
        Write-Log ((T 'log_failed') -f $_.Exception.Message)
        [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, (T 'done_title'), [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    }
    finally {
        $btnWrite.Enabled = $true
        $btnAdd.Enabled = $true
        $btnFolder.Enabled = $true
        $btnClear.Enabled = $true
        $form.Cursor = [System.Windows.Forms.Cursors]::Default
    }
})

Load-Settings
Apply-Settings

$chkBackup.Add_CheckedChanged({ Save-BackupPref })

if ($script:Lang -eq 'en') { $cmbLang.SelectedIndex = 1 } else { $cmbLang.SelectedIndex = 0 }
$script:LangInit = $true

$cmbLang.Add_SelectedIndexChanged({
    if (-not $script:LangInit) { return }
    $new = 'zh'
    if ($cmbLang.SelectedIndex -eq 1) { $new = 'en' }
    if ($new -eq $script:Lang) { return }
    $script:Lang = $new
    Save-Lang
    Apply-Language
    Write-Log (T 'log_lang')
})

Apply-Language

$script:ExifTool = Find-ExifTool

# 启动参数：
#   gpsstamp://…?dir=…        「只挑缺 GPS」的入口（浏览器靠协议唤起时用）
#   --missing-only <文件夹>    同上，供桌面壳（PhotoCove Electron 版）直接调用
#   其余文件/文件夹             全量添加（拖拽语义）
# --missing-only 很关键：桌面壳若按普通文件夹传进来，会全量载入，
# 一按写入就把原本已有坐标的照片全部覆盖成同一个位置。
$startupDirs = @()
$startupPaths = @()
if ($StartupFiles -and $StartupFiles.Count -gt 0) {
    $i = 0
    while ($i -lt $StartupFiles.Count) {
        $a = [string]$StartupFiles[$i]
        if ([string]::IsNullOrWhiteSpace($a)) { $i++; continue }

        if ($a -match '^(?i)--missing-only$') {
            if ($i + 1 -lt $StartupFiles.Count) {
                $d = [string]$StartupFiles[$i + 1]
                if (-not [string]::IsNullOrWhiteSpace($d)) { $startupDirs += $d }
                $i += 2
            } else { $i++ }
            continue
        }

        $target = Get-LaunchTarget $a
        if ($target.Kind -eq 'dir') { if ($target.Path) { $startupDirs += $target.Path } }
        else { $startupPaths += $target.Path }
        $i++
    }
}

if ($script:ExifTool) {
    Write-Log ((T 'log_exif') -f $script:ExifTool)
} else {
    Write-Log (T 'log_no_exif')
}

# 窗口先显示出来，再读文件夹：几百张照片的 GPS 检查要几秒，
# 放在 ShowDialog 之前会让人以为程序没启动。
if ($startupDirs.Count -gt 0 -or $startupPaths.Count -gt 0) {
    $form.Add_Shown({
        foreach ($d in $startupDirs) { Add-FolderMissingGps $d }
        if ($startupPaths.Count -gt 0) { Add-Paths -Paths $startupPaths }
    })
}

[void]$form.ShowDialog()
$form.Dispose()
