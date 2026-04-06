[CmdletBinding()]
param(
    [string]$SourcePath = "C:\Calc_Equity\equity-viewer",
    [string]$SiteName = "Default Web Site",
    [string]$ApplicationName = "equity-viewer",
    [string]$DeployPath = "C:\inetpub\wwwroot\equity-viewer"
)

$ErrorActionPreference = "Stop"

Import-Module WebAdministration

if (-not (Test-Path -LiteralPath $SourcePath)) {
    throw "Source path not found: $SourcePath"
}

$pythonSourcePath = (Get-Command python -ErrorAction Stop).Source
$pythonSourceRoot = Split-Path -Path $pythonSourcePath -Parent
$pythonRuntimeRoot = "C:\inetpub\python-runtime\Python313"
$pythonPath = Join-Path $pythonRuntimeRoot "python.exe"
$visitCounterServiceScript = "C:\Calc_Equity\scripts\visit_counter_service.py"
$visitCounterTaskName = "CalcEquityVisitCounter"
$visitCounterFirewallRule = "Calc Equity Visit Counter 8123"
$dataPath = Join-Path $DeployPath "data"

$existingTaskBeforeCopy = Get-ScheduledTask -TaskName $visitCounterTaskName -ErrorAction SilentlyContinue
if ($existingTaskBeforeCopy) {
    Stop-ScheduledTask -TaskName $visitCounterTaskName -ErrorAction SilentlyContinue
}
$listener = Get-NetTCPConnection -LocalPort 8123 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
}

New-Item -ItemType Directory -Force -Path $pythonRuntimeRoot | Out-Null
Copy-Item -Path (Join-Path $pythonSourceRoot "*") -Destination $pythonRuntimeRoot -Recurse -Force

New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null
Copy-Item -Path (Join-Path $SourcePath "*") -Destination $DeployPath -Recurse -Force
New-Item -ItemType Directory -Force -Path $dataPath | Out-Null

$existingApp = Get-WebApplication -Site $SiteName -Name $ApplicationName -ErrorAction SilentlyContinue
if (-not $existingApp) {
    New-WebApplication -Site $SiteName -Name $ApplicationName -PhysicalPath $DeployPath | Out-Null
} else {
    Set-ItemProperty "IIS:\Sites\$SiteName\$ApplicationName" -Name physicalPath -Value $DeployPath
}

icacls $pythonRuntimeRoot /grant "IIS AppPool\DefaultAppPool:(OI)(CI)RX" /t | Out-Null
icacls $pythonRuntimeRoot /grant "IIS_IUSRS:(OI)(CI)RX" /t | Out-Null
icacls $pythonRuntimeRoot /grant "IUSR:(OI)(CI)RX" /t | Out-Null
icacls $DeployPath /grant "IIS AppPool\DefaultAppPool:(OI)(CI)RX" /t | Out-Null
icacls $dataPath /grant "IIS AppPool\DefaultAppPool:(OI)(CI)M" /t | Out-Null
icacls $DeployPath /grant "IIS_IUSRS:(OI)(CI)RX" /t | Out-Null
icacls $DeployPath /grant "IUSR:(OI)(CI)RX" /t | Out-Null

if (-not (Get-NetFirewallRule -DisplayName $visitCounterFirewallRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $visitCounterFirewallRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8123 | Out-Null
}

$existingTask = Get-ScheduledTask -TaskName $visitCounterTaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Stop-ScheduledTask -TaskName $visitCounterTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $visitCounterTaskName -Confirm:$false
}

$taskAction = New-ScheduledTaskAction -Execute $pythonPath -Argument "`"$visitCounterServiceScript`""
$taskTrigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $visitCounterTaskName `
    -Action $taskAction `
    -Trigger $taskTrigger `
    -Principal $taskPrincipal `
    -Settings $taskSettings `
    | Out-Null

Start-ScheduledTask -TaskName $visitCounterTaskName

Write-Host "Deployed to http://localhost/$ApplicationName/"
